import type {
  AnyNode,
  AnyNodeId,
  BuildingNode,
  CeilingNode,
  ElevatorNode,
  SlabNode,
  StairNode,
  StairSegmentNode,
  WallNode,
} from '../schema'
import { LevelNode } from '../schema/nodes/level'
import { computeWallSlabSupport } from '../systems/slab/slab-support'
import { MIN_WALL_HEIGHT, resolveWallTop } from '../systems/wall/wall-top'
import {
  CEILING_CLAMP_MARGIN,
  getCeilingClampBound,
  getLevelElevations,
  getLevelFloorToFloorHeight,
  getStoredLevelHeight,
} from './storey'

/**
 * Hard ceiling on the number of levels one batch may create (above-ground +
 * basement combined). Guards the store against a typo generating a skyscraper.
 */
export const MAX_BATCH_LEVEL_COUNT = 100

/** Legal storey-height range in meters, inclusive. */
export const MIN_STOREY_HEIGHT = 2.2
export const MAX_STOREY_HEIGHT = 6

/** Default heights offered by the batch dialog. */
export const DEFAULT_BATCH_LEVEL_HEIGHTS = {
  ground: 3,
  standard: 2.8,
  basement: 2.8,
  top: 2.8,
} as const

/**
 * How far a wall top / ceiling height may sit from the storey plane and still
 * count as "tracking the plane". Mirrors the load migration's
 * `PLANE_BOUND_EPSILON` so a wall or ceiling the migration decided was
 * plane-bound keeps tracking after a batch height edit.
 */
const PLANE_TRACKING_EPSILON = 0.2

/**
 * How close a stair's explicit `totalRise` must be to the level's derived
 * floor-to-floor rise before a batch height change rewrites it. Anything
 * further away is a hand-authored rise and is left alone.
 */
const RISE_TRACKING_EPSILON = 0.01

export type BatchLevelHeights = {
  /** Height of the first (lowest) level of the above-ground block. */
  ground: number
  /** Height of every level strictly between the first and the last. */
  standard: number
  /** Height of every basement level. */
  basement: number
  /** Height of the topmost level of the above-ground block. */
  top: number
}

export type BatchLevelMode = 'append' | 'rebuild'

export type BatchLevelRequest = {
  buildingId: AnyNodeId
  /** Above-ground levels to create. Level 0 (the ground floor) is included. */
  aboveCount: number
  /** Basement levels to create (ordinals -1 … -M). */
  belowCount: number
  heights: BatchLevelHeights
  mode: BatchLevelMode
}

/**
 * A self-contained set of scene mutations. Every planner here returns one so
 * the caller can apply the whole batch in a single `applyNodeChanges` call —
 * one store write, therefore one undo entry.
 */
export type StoreyBatchChange = {
  create: { node: AnyNode; parentId?: AnyNodeId }[]
  update: { id: AnyNodeId; data: Partial<AnyNode> }[]
  delete: AnyNodeId[]
}

export type StoreyPlanResult<T> = { ok: true; result: T } | { ok: false; errors: string[] }

export function emptyStoreyBatchChange(): StoreyBatchChange {
  return { create: [], update: [], delete: [] }
}

export function isStoreyHeightInRange(height: number): boolean {
  return (
    typeof height === 'number' &&
    Number.isFinite(height) &&
    height >= MIN_STOREY_HEIGHT &&
    height <= MAX_STOREY_HEIGHT
  )
}

function isWholeNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.trunc(value) === value
}

function formatHeightRange(): string {
  return `${MIN_STOREY_HEIGHT}–${MAX_STOREY_HEIGHT} m`
}

function childrenOf(nodes: Record<AnyNodeId, AnyNode>, node: AnyNode | undefined): AnyNode[] {
  if (!node || !('children' in node) || !Array.isArray(node.children)) return []
  return (node.children as AnyNodeId[])
    .map((childId) => nodes[childId])
    .filter((child): child is AnyNode => child !== undefined)
}

function getBuildingLevels(nodes: Record<AnyNodeId, AnyNode>, buildingId: AnyNodeId): LevelNode[] {
  const building = nodes[buildingId]
  if (building?.type !== 'building') return []
  return building.children
    .map((childId) => nodes[childId as AnyNodeId])
    .filter((node): node is LevelNode => node?.type === 'level')
    .sort((left, right) => left.level - right.level)
}

/**
 * Validates a batch request against the scene. Returns user-facing error
 * strings; an empty array means the request can be planned. Pure — callers
 * run this before touching the store so a rejected request never writes a
 * half-finished block of levels.
 */
export function validateBatchLevelRequest(
  nodes: Record<AnyNodeId, AnyNode>,
  request: BatchLevelRequest,
): string[] {
  const errors: string[] = []
  const building = nodes[request.buildingId]
  if (building?.type !== 'building') {
    return ['Select a building before creating levels.']
  }

  const { aboveCount, belowCount } = request
  if (!isWholeNumber(aboveCount) || aboveCount < 0) {
    errors.push('Above-ground level count must be a whole number of 0 or more.')
  }
  if (!isWholeNumber(belowCount) || belowCount < 0) {
    errors.push('Basement level count must be a whole number of 0 or more.')
  }

  const total =
    (Number.isFinite(aboveCount) ? aboveCount : 0) + (Number.isFinite(belowCount) ? belowCount : 0)
  if (total > MAX_BATCH_LEVEL_COUNT) {
    errors.push(`A batch may create at most ${MAX_BATCH_LEVEL_COUNT} levels (requested ${total}).`)
  }
  if (total <= 0) {
    errors.push('Create at least one level.')
  }

  const heights = request.heights
  const heightLabels: Array<[keyof BatchLevelHeights, string]> = [
    ['ground', 'Ground floor height'],
    ['standard', 'Typical floor height'],
    ['basement', 'Basement height'],
    ['top', 'Top floor height'],
  ]
  for (const [key, label] of heightLabels) {
    if (!isStoreyHeightInRange(heights?.[key])) {
      errors.push(`${label} must be between ${formatHeightRange()}.`)
    }
  }

  if (request.mode !== 'append' && request.mode !== 'rebuild') {
    errors.push('Unknown batch mode.')
  }

  const existingLevels = getBuildingLevels(nodes, request.buildingId)
  const hasGroundFloor = existingLevels.some((level) => level.level === 0)
  const keepsGroundFloor = request.mode === 'append' && hasGroundFloor
  const effectiveAbove = Math.max(aboveCount, keepsGroundFloor ? 0 : 1)
  const projected = existingLevels.length + effectiveAbove + belowCount
  if (projected > MAX_BATCH_LEVEL_COUNT) {
    errors.push(
      `This building would end up with ${projected} levels; the limit is ${MAX_BATCH_LEVEL_COUNT}.`,
    )
  }

  return errors
}

/**
 * Heights for one above-ground block of `count` levels, bottom-up: the first
 * level takes the ground height, the last takes the top height, and anything
 * between takes the typical height. A single-level block is its own ground
 * floor — there is no top floor to speak of.
 */
export function resolveAboveGroundBlockHeights(
  count: number,
  heights: BatchLevelHeights,
): number[] {
  if (!Number.isFinite(count) || count <= 0) return []
  if (count === 1) return [heights.ground]
  const result: number[] = [heights.ground]
  for (let index = 1; index < count - 1; index += 1) {
    result.push(heights.standard)
  }
  result.push(heights.top)
  return result
}

/**
 * Plans a batch of levels for one building.
 *
 * - `append` stacks the new above-ground block on top of the building's
 *   current topmost level and the new basements below its current bottom.
 * - `rebuild` deletes every existing level of the building (with its whole
 *   subtree) and lays down a fresh block anchored at level 0.
 *
 * A building with no level 0 always gets one: the ordinal-0 ground floor is
 * the vertical model's zero anchor and the only non-deletable level.
 *
 * Pure — returns the mutations instead of applying them.
 */
export function planBatchLevels(
  nodes: Record<AnyNodeId, AnyNode>,
  request: BatchLevelRequest,
): StoreyPlanResult<{ changes: StoreyBatchChange; createdLevelIds: AnyNodeId[] }> {
  const errors = validateBatchLevelRequest(nodes, request)
  if (errors.length > 0) return { ok: false, errors }

  const building = nodes[request.buildingId] as BuildingNode
  const existingLevels = getBuildingLevels(nodes, request.buildingId)
  const hasGroundFloor = existingLevels.some((level) => level.level === 0)
  const keepsGroundFloor = request.mode === 'append' && hasGroundFloor
  const aboveCount = Math.max(request.aboveCount, keepsGroundFloor ? 0 : 1)
  const belowCount = Math.max(0, Math.trunc(request.belowCount))

  const changes = emptyStoreyBatchChange()
  const createdLevelIds: AnyNodeId[] = []

  if (request.mode === 'rebuild') {
    for (const level of existingLevels) changes.delete.push(level.id)
  }

  // Ordinal anchors for the new blocks.
  const existingOrdinals = existingLevels.map((level) => level.level)
  const maxOrdinal = existingOrdinals.length > 0 ? Math.max(...existingOrdinals) : -1
  const minOrdinal = existingOrdinals.length > 0 ? Math.min(...existingOrdinals) : 0

  const aboveStart = request.mode === 'rebuild' || existingLevels.length === 0 ? 0 : maxOrdinal + 1
  const basementStart = existingLevels.length === 0 ? -belowCount : minOrdinal - belowCount

  const aboveHeights = resolveAboveGroundBlockHeights(aboveCount, request.heights)
  for (let index = 0; index < aboveCount; index += 1) {
    const ordinal = aboveStart + index
    const levelNode = LevelNode.parse({
      level: ordinal,
      height: aboveHeights[index],
      children: [],
      parentId: building.id,
    })
    changes.create.push({ node: levelNode, parentId: building.id })
    createdLevelIds.push(levelNode.id as AnyNodeId)
  }

  for (let index = 0; index < belowCount; index += 1) {
    const ordinal = basementStart + index
    const levelNode = LevelNode.parse({
      level: ordinal,
      height: request.heights.basement,
      children: [],
      parentId: building.id,
    })
    changes.create.push({ node: levelNode, parentId: building.id })
    createdLevelIds.push(levelNode.id as AnyNodeId)
  }

  // Rebuilding drops elevator level references along with the levels they
  // pointed at; a dangling id degrades gracefully at render time but would
  // silently shrink a shaft's service range.
  if (request.mode === 'rebuild' && changes.delete.length > 0) {
    const deletedIds = new Set(changes.delete)
    for (const node of Object.values(nodes)) {
      if (node?.type !== 'elevator' || node.parentId !== building.id) continue
      const elevator = node as ElevatorNode
      const patch: Partial<ElevatorNode> = {}
      if (elevator.fromLevelId && deletedIds.has(elevator.fromLevelId as AnyNodeId)) {
        patch.fromLevelId = null
      }
      if (elevator.toLevelId && deletedIds.has(elevator.toLevelId as AnyNodeId)) {
        patch.toLevelId = null
      }
      if (elevator.defaultLevelId && deletedIds.has(elevator.defaultLevelId as AnyNodeId)) {
        patch.defaultLevelId = null
      }
      const listFields = ['servedLevelIds', 'disabledLevelIds', 'serviceOnlyLevelIds'] as const
      for (const field of listFields) {
        const list = elevator[field]
        if (!Array.isArray(list)) continue
        const nextList = list.filter((id) => !deletedIds.has(id as AnyNodeId))
        if (nextList.length !== list.length) {
          ;(patch as Record<string, unknown>)[field] =
            field === 'servedLevelIds' && nextList.length === 0 ? undefined : nextList
        }
      }
      if (Object.keys(patch).length > 0) {
        changes.update.push({ id: elevator.id as AnyNodeId, data: patch as Partial<AnyNode> })
      }
    }
  }

  return { ok: true, result: { changes, createdLevelIds } }
}

export type LevelHeightUpdateOptions = {
  /**
   * Reject heights outside {@link MIN_STOREY_HEIGHT}–{@link MAX_STOREY_HEIGHT}.
   * The batch UI turns it on; a single level's height slider keeps its own
   * wider range, which predates the batch flow.
   */
  enforceHeightRange?: boolean
}

/**
 * Plans a batch storey-height change for `levelIds`, including the geometry
 * that has to follow the plane so nothing ends up floating or intersecting:
 *
 * - Walls whose top tracked the old plane keep tracking the new one (explicit
 *   `height` included); plane-bound walls need no write at all.
 * - Ceilings that tracked their clamp bound follow it.
 * - Stairs on the level whose explicit `totalRise` tracked the level's
 *   floor-to-floor rise are rewritten, together with their flight segments.
 *   Follows-mode stairs derive their rise and are re-synced by
 *   `syncStairRises` after the write.
 *
 * Levels above the edited ones are NOT written: `getLevelElevations` stacks
 * them from the stored heights, so they translate on their own — including
 * typical-floor instances.
 *
 * Pure — returns the mutations instead of applying them.
 */
export function planLevelHeightUpdates(
  nodes: Record<AnyNodeId, AnyNode>,
  levelIds: AnyNodeId[],
  height: number,
  options: LevelHeightUpdateOptions = {},
): StoreyPlanResult<StoreyBatchChange> {
  if (options.enforceHeightRange === true && !isStoreyHeightInRange(height)) {
    return {
      ok: false,
      errors: [`Storey height must be between ${formatHeightRange()} (received ${height}).`],
    }
  }

  const changes = emptyStoreyBatchChange()
  const seen = new Set<AnyNodeId>()
  for (const levelId of levelIds) {
    if (seen.has(levelId)) continue
    seen.add(levelId)
    const level = nodes[levelId]
    if (level?.type !== 'level') continue

    const oldHeight = getStoredLevelHeight(level as LevelNode)
    const delta = height - oldHeight
    if (Math.abs(delta) < 1e-9) continue

    changes.update.push({ id: levelId, data: { height } as Partial<AnyNode> })
    collectPlaneTrackingUpdates(nodes, level as LevelNode, oldHeight, height, changes)
  }

  return { ok: true, result: changes }
}

function collectPlaneTrackingUpdates(
  nodes: Record<AnyNodeId, AnyNode>,
  level: LevelNode,
  oldHeight: number,
  nextHeight: number,
  changes: StoreyBatchChange,
): void {
  const delta = nextHeight - oldHeight
  const children = childrenOf(nodes, level)
  const walls = children.filter((child): child is WallNode => child.type === 'wall')
  const slabs = children.filter((child): child is SlabNode => child.type === 'slab')

  for (const wall of walls) {
    // Plane-bound walls (no stored height) resolve their top from the storey
    // plane every frame — nothing to write.
    if (wall.height == null) continue
    const electedBase = computeWallSlabSupport(
      {
        start: wall.start,
        end: wall.end,
        curveOffset: wall.curveOffset,
        thickness: wall.thickness,
      },
      slabs,
      walls,
    ).elevation
    const top = resolveWallTop(wall, oldHeight, electedBase)
    if (Math.abs(top - oldHeight) > PLANE_TRACKING_EPSILON) continue
    // `top - height` is the base contribution `resolveWallTop` applied
    // (elected base when positive, zero otherwise, always the base for
    // ground-hosted walls). Keeping it constant re-pins the top to the plane.
    const baseContribution = top - wall.height
    const nextWallHeight = Math.max(MIN_WALL_HEIGHT, nextHeight - baseContribution)
    if (Math.abs(nextWallHeight - wall.height) < 1e-9) continue
    changes.update.push({ id: wall.id as AnyNodeId, data: { height: nextWallHeight } })
  }

  for (const child of children) {
    if (child.type !== 'ceiling') continue
    const ceiling = child as CeilingNode
    if (ceiling.height == null) continue
    const bound = getCeilingClampBound(level.id, nodes, ceiling.polygon)
    if (!Number.isFinite(bound)) continue
    if (Math.abs(ceiling.height - bound) > PLANE_TRACKING_EPSILON) continue
    const nextCeilingHeight = Math.max(CEILING_CLAMP_MARGIN, bound + delta)
    if (Math.abs(nextCeilingHeight - ceiling.height) < 1e-9) continue
    changes.update.push({
      id: ceiling.id as AnyNodeId,
      data: { height: nextCeilingHeight } as Partial<AnyNode>,
    })
  }

  const oldRise = getLevelFloorToFloorHeight(level.id, nodes)
  const nextRise = oldRise + delta
  if (oldRise <= 1e-9 || Math.abs(nextRise - oldRise) < 1e-9) return
  const ratio = nextRise / oldRise

  for (const child of children) {
    if (child.type !== 'stair') continue
    const stair = child as StairNode
    // Follows-mode stairs read their rise from the level; `syncStairRises`
    // converges their flight segments after the write.
    if (stair.totalRise == null) continue
    if (Math.abs(stair.totalRise - oldRise) > RISE_TRACKING_EPSILON) continue

    changes.update.push({
      id: stair.id as AnyNodeId,
      data: { totalRise: nextRise } as Partial<AnyNode>,
    })

    const flights = childrenOf(nodes, stair).filter(
      (segment): segment is StairSegmentNode =>
        segment.type === 'stair-segment' && segment.segmentType === 'stair',
    )
    for (const flight of flights) {
      changes.update.push({
        id: flight.id as AnyNodeId,
        data: { height: flight.height * ratio } as Partial<AnyNode>,
      })
    }
  }
}

export type StoreyOverviewRow = {
  id: AnyNodeId
  /** Level ordinal: 0 is the ground floor, negatives are basements. */
  ordinal: number
  name: string
  /** Stored storey height in meters. */
  height: number
  /** World Y of the level's floor: cumulative heights through the stack. */
  baseY: number
  /** World Y of the level's ceiling. */
  topY: number
  wallCount: number
  slabCount: number
  itemCount: number
}

function countChildrenByType(node: AnyNode | undefined, nodes: Record<AnyNodeId, AnyNode>) {
  let wallCount = 0
  let slabCount = 0
  let itemCount = 0
  for (const child of childrenOf(nodes, node)) {
    if (child.type === 'wall') wallCount += 1
    else if (child.type === 'slab') slabCount += 1
    else if (child.type === 'item') itemCount += 1
  }
  return { wallCount, slabCount, itemCount }
}

/**
 * Tabular vertical overview of one building, top level first — the order the
 * floating selector and the overview panel both present. Elevations come from
 * `getLevelElevations`, the same pure stack the renderer reads, so the panel
 * can never disagree with the scene.
 */
export function getStoreyOverviewRows(
  nodes: Record<AnyNodeId, AnyNode>,
  buildingId: AnyNodeId | null | undefined,
): StoreyOverviewRow[] {
  if (!buildingId) return []
  const levels = getBuildingLevels(nodes, buildingId)
  if (levels.length === 0) return []

  const elevations = getLevelElevations(nodes)
  return levels
    .map((level) => {
      const elevation = elevations.get(level.id)
      const height = getStoredLevelHeight(level)
      const baseY = elevation?.baseY ?? 0
      return {
        id: level.id as AnyNodeId,
        ordinal: level.level,
        name: level.name ?? '',
        height,
        baseY,
        topY: baseY + height,
        ...countChildrenByType(level, nodes),
      }
    })
    .sort((left, right) => right.ordinal - left.ordinal)
}
