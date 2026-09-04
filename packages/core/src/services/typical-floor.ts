import type { AnyNode, AnyNodeId, AnyNodeType, BuildingNode } from '../schema'
import { LevelNode } from '../schema/nodes/level'
import { cloneLevelSubtree } from '../utils/clone-scene-graph'
import { getStoredLevelHeight } from './storey'
import {
  MAX_BATCH_LEVEL_COUNT,
  type StoreyBatchChange,
  type StoreyPlanResult,
} from './storey-batch'

/**
 * Node kinds a typical-floor master owns — the "structural" content that a
 * sync pushes onto every derived instance: walls, slabs, ceilings and the
 * openings hosted by them, plus the horizontal/vertical structure that rides
 * along (stairs, roofs, columns, grids, zones).
 *
 * Everything else is treated as furniture, reference imagery or annotation,
 * which a sync must never clear or overwrite (an item a user drops on an
 * instance after deriving it is theirs, not the master's).
 */
export const TYPICAL_FLOOR_STRUCTURAL_TYPES: ReadonlySet<AnyNodeType> = new Set<AnyNodeType>([
  'wall',
  'fence',
  'column',
  'block',
  'zone',
  'slab',
  'ceiling',
  'roof',
  'roof-segment',
  'stair',
  'stair-segment',
  'window',
  'door',
  'structural-grid',
])

/**
 * Never copied out of a master: user-uploaded imagery and the walk-through
 * spawn anchor. They belong to the level they were captured on.
 */
export const TYPICAL_FLOOR_EXCLUDED_TYPES: ReadonlySet<AnyNodeType> = new Set<AnyNodeType>([
  'scan',
  'guide',
  'spawn',
])

export function isTypicalFloorStructuralType(type: AnyNodeType): boolean {
  return TYPICAL_FLOOR_STRUCTURAL_TYPES.has(type)
}

export function isTypicalMaster(level: LevelNode | undefined | null): boolean {
  return level?.typicalMaster === true
}

/** The master level id an instance was derived from, or `null`. */
export function getTypicalMasterId(level: LevelNode | undefined | null): AnyNodeId | null {
  if (!level) return null
  const masterId = level.typicalMasterId
  return typeof masterId === 'string' && masterId.length > 0 ? (masterId as AnyNodeId) : null
}

export function isTypicalInstance(level: LevelNode | undefined | null): boolean {
  return getTypicalMasterId(level) !== null
}

export function isTypicalMasterOf(
  nodes: Record<AnyNodeId, AnyNode>,
  masterId: AnyNodeId,
  candidateId: AnyNodeId,
): boolean {
  return getTypicalMasterId(nodes[candidateId] as LevelNode | undefined) === masterId
}

/** Every level derived from `masterId`, ordered by ordinal ascending. */
export function findTypicalInstanceIds(
  nodes: Record<AnyNodeId, AnyNode>,
  masterId: AnyNodeId,
): AnyNodeId[] {
  const instances: Array<{ id: AnyNodeId; ordinal: number }> = []
  for (const node of Object.values(nodes)) {
    if (node?.type !== 'level') continue
    if (getTypicalMasterId(node as LevelNode) !== masterId) continue
    instances.push({ id: node.id as AnyNodeId, ordinal: (node as LevelNode).level })
  }
  return instances.sort((left, right) => left.ordinal - right.ordinal).map((entry) => entry.id)
}

export function countTypicalInstances(
  nodes: Record<AnyNodeId, AnyNode>,
  masterId: AnyNodeId,
): number {
  return findTypicalInstanceIds(nodes, masterId).length
}

function resolveBuildingId(nodes: Record<AnyNodeId, AnyNode>, level: LevelNode): AnyNodeId | null {
  const direct = level.parentId ? nodes[level.parentId as AnyNodeId] : undefined
  if (direct?.type === 'building') return direct.id as AnyNodeId

  for (const node of Object.values(nodes)) {
    if (node?.type !== 'building') continue
    if ((node as BuildingNode).children.includes(level.id)) return node.id as AnyNodeId
  }
  return null
}

function childIdsOf(node: AnyNode): AnyNodeId[] {
  if (!('children' in node) || !Array.isArray(node.children)) return []
  return node.children as AnyNodeId[]
}

/**
 * Deep-copies a master level's content with fresh ids, dropping the excluded
 * kinds and any dangling child references left behind by a drop. The copied
 * level node itself is not part of the result — callers graft the content
 * onto a level that already exists.
 */
function cloneMasterContent(
  nodes: Record<AnyNodeId, AnyNode>,
  masterId: AnyNodeId,
): { content: AnyNode[]; topLevelIds: AnyNodeId[] } | null {
  const { clonedNodes, newLevelId } = cloneLevelSubtree(nodes, masterId)
  const clonedById = new Map<AnyNodeId, AnyNode>(clonedNodes.map((node) => [node.id, node]))
  const clonedLevel = clonedById.get(newLevelId)
  if (!clonedLevel) return null

  const kept = new Set<AnyNodeId>()
  for (const node of clonedNodes) {
    if (TYPICAL_FLOOR_EXCLUDED_TYPES.has(node.type)) continue
    kept.add(node.id as AnyNodeId)
  }

  const topLevelIds: AnyNodeId[] = []
  const content: AnyNode[] = []
  for (const node of clonedNodes) {
    if (node.id === newLevelId) continue
    if (!kept.has(node.id as AnyNodeId)) continue
    if ('children' in node && Array.isArray(node.children)) {
      // Cast rather than assign through the union: each member types
      // `children` as its own id union, and the filtered array is plain
      // `AnyNodeId[]`.
      const withChildren = node as unknown as { children: AnyNodeId[] }
      withChildren.children = withChildren.children.filter((childId) => kept.has(childId))
    }
    content.push(node)
  }
  for (const childId of childIdsOf(clonedLevel)) {
    if (kept.has(childId)) topLevelIds.push(childId)
  }

  return { content, topLevelIds }
}

/**
 * Queues the structural content of a level for deletion without ever
 * disturbing furniture: a branch holding a preserved node keeps its anchor,
 * and only the deletable descendants below it go.
 *
 * Returns `true` when the whole subtree rooted at `id` was queued.
 */
function collectStructuralDeletions(
  nodes: Record<AnyNodeId, AnyNode>,
  id: AnyNodeId,
  out: AnyNodeId[],
): boolean {
  const node = nodes[id]
  if (!node) return true
  if (!isTypicalFloorStructuralType(node.type)) return false

  let everyChildDeletable = true
  for (const childId of childIdsOf(node)) {
    if (!collectStructuralDeletions(nodes, childId, out)) {
      everyChildDeletable = false
    }
  }
  if (!everyChildDeletable) return false

  out.push(id)
  return true
}

export type TypicalFloorInstanceRequest = {
  masterLevelId: AnyNodeId
  instanceCount: number
}

/**
 * Derives `instanceCount` typical-floor instances from a master level.
 *
 * Instances are inserted directly above the master (exactly like the
 * single-level duplicate flow), every higher level shifts up by the same
 * amount, and each new level starts life as a full copy of the master's
 * content minus scans, guides and spawn anchors.
 *
 * Pure — returns the mutations instead of applying them.
 */
export function planTypicalFloorInstances(
  nodes: Record<AnyNodeId, AnyNode>,
  request: TypicalFloorInstanceRequest,
): StoreyPlanResult<{ changes: StoreyBatchChange; createdLevelIds: AnyNodeId[] }> {
  const master = nodes[request.masterLevelId]
  if (master?.type !== 'level') {
    return { ok: false, errors: ['Typical floor instances need a level to derive from.'] }
  }
  const masterLevel = master as LevelNode
  const buildingId = resolveBuildingId(nodes, masterLevel)
  if (!buildingId) {
    return { ok: false, errors: ['The master level does not belong to a building.'] }
  }

  const count = Math.trunc(request.instanceCount)
  if (!Number.isFinite(count) || count < 1) {
    return { ok: false, errors: ['Derive at least one instance.'] }
  }

  const building = nodes[buildingId] as BuildingNode
  const siblingLevels = building.children
    .map((childId) => nodes[childId as AnyNodeId])
    .filter((node): node is LevelNode => node?.type === 'level')
  if (siblingLevels.length + count > MAX_BATCH_LEVEL_COUNT) {
    return {
      ok: false,
      errors: [
        `This building would end up with ${siblingLevels.length + count} levels; the limit is ${MAX_BATCH_LEVEL_COUNT}.`,
      ],
    }
  }

  const firstOrdinal = masterLevel.level + 1
  const shifted = siblingLevels
    .filter((level) => level.level >= firstOrdinal)
    .map((level) => ({
      id: level.id as AnyNodeId,
      data: { level: level.level + count } as Partial<AnyNode>,
    }))

  const changes: StoreyBatchChange = {
    create: [],
    update: [
      { id: masterLevel.id as AnyNodeId, data: { typicalMaster: true } as Partial<AnyNode> },
      ...shifted,
    ],
    delete: [],
  }
  const createdLevelIds: AnyNodeId[] = []
  const masterHeight = getStoredLevelHeight(masterLevel)

  for (let index = 0; index < count; index += 1) {
    const ordinal = firstOrdinal + index
    const instance = LevelNode.parse({
      level: ordinal,
      height: masterHeight,
      children: [],
      parentId: buildingId,
      typicalMasterId: masterLevel.id,
    })
    changes.create.push({ node: instance, parentId: buildingId })
    createdLevelIds.push(instance.id as AnyNodeId)
  }

  // Content is grafted after the level nodes themselves so `applyNodeChanges`
  // can append every cloned child to a parent that already exists. Clone
  // order is parents-first, straight out of `cloneLevelSubtree`.
  for (const instanceId of createdLevelIds) {
    const cloned = cloneMasterContent(nodes, masterLevel.id)
    if (!cloned) continue
    const topLevel = new Set<AnyNodeId>(cloned.topLevelIds)
    for (const node of cloned.content) {
      if (topLevel.has(node.id as AnyNodeId)) {
        changes.create.push({ node: { ...node, parentId: instanceId }, parentId: instanceId })
      } else {
        changes.create.push({ node })
      }
    }
  }

  return { ok: true, result: { changes, createdLevelIds } }
}

/**
 * Pushes a master's current structural content onto every derived instance.
 *
 * Each instance loses the structure it inherited last time (furniture,
 * reference imagery and annotations survive untouched) and gains a fresh copy
 * of the master's walls, slabs, ceilings, openings and stairs. Pure.
 */
export function planSyncTypicalFloorInstances(
  nodes: Record<AnyNodeId, AnyNode>,
  masterLevelId: AnyNodeId,
): StoreyPlanResult<StoreyBatchChange> {
  const master = nodes[masterLevelId]
  if (master?.type !== 'level' || !isTypicalMaster(master as LevelNode)) {
    return { ok: false, errors: ['Only a typical-floor master can be synced.'] }
  }

  const instanceIds = findTypicalInstanceIds(nodes, masterLevelId)
  if (instanceIds.length === 0) {
    return { ok: false, errors: ['This master has no typical-floor instances yet.'] }
  }

  const changes: StoreyBatchChange = { create: [], update: [], delete: [] }
  for (const instanceId of instanceIds) {
    const instance = nodes[instanceId]
    if (instance?.type !== 'level') continue

    const deletions: AnyNodeId[] = []
    for (const childId of childIdsOf(instance)) {
      collectStructuralDeletions(nodes, childId, deletions)
    }
    changes.delete.push(...deletions)

    const cloned = cloneMasterContent(nodes, masterLevelId)
    if (!cloned) continue
    const topLevel = new Set<AnyNodeId>(cloned.topLevelIds)
    for (const node of cloned.content) {
      if (topLevel.has(node.id as AnyNodeId)) {
        changes.create.push({ node: { ...node, parentId: instanceId }, parentId: instanceId })
      } else {
        changes.create.push({ node })
      }
    }
  }

  return { ok: true, result: changes }
}

/**
 * Turns every instance of `masterLevelId` back into an ordinary level by
 * dropping its back-reference. Used when the master is deleted or unmarked,
 * so no level is left pointing at a master that no longer exists.
 */
export function planDetachTypicalInstances(
  nodes: Record<AnyNodeId, AnyNode>,
  masterLevelId: AnyNodeId,
): StoreyBatchChange {
  const instanceIds = findTypicalInstanceIds(nodes, masterLevelId)
  return {
    create: [],
    update: instanceIds.map((id) => ({
      id,
      data: { typicalMasterId: undefined } as Partial<AnyNode>,
    })),
    delete: [],
  }
}

export type SetTypicalMasterRequest = {
  levelId: AnyNodeId
  isMaster: boolean
}

/**
 * Marks or unmarks a level as a typical-floor master. Unmarking detaches the
 * existing instances in the same commit — a level that is no longer a master
 * cannot keep instances pointing at it.
 */
export function planSetTypicalMaster(
  nodes: Record<AnyNodeId, AnyNode>,
  request: SetTypicalMasterRequest,
): StoreyPlanResult<StoreyBatchChange> {
  const level = nodes[request.levelId]
  if (level?.type !== 'level') {
    return { ok: false, errors: ['Only a level can be a typical-floor master.'] }
  }
  const levelNode = level as LevelNode

  if (request.isMaster) {
    // A master cannot itself be derived from another master: the sync would
    // overwrite the very content it is meant to own.
    return {
      ok: true,
      result: {
        create: [],
        update: [
          {
            id: levelNode.id as AnyNodeId,
            data: {
              typicalMaster: true,
              typicalMasterId: undefined,
            } as Partial<AnyNode>,
          },
        ],
        delete: [],
      },
    }
  }

  const detach = planDetachTypicalInstances(nodes, levelNode.id as AnyNodeId)
  detach.update.push({
    id: levelNode.id as AnyNodeId,
    data: { typicalMaster: undefined } as Partial<AnyNode>,
  })
  return { ok: true, result: detach }
}
