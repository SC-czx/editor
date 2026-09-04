import { describe, expect, test } from 'bun:test'
import {
  BuildingNode,
  CeilingNode,
  LevelNode,
  SlabNode,
  StairNode,
  StairSegmentNode,
  WallNode,
} from '../schema'
import type { AnyNode, AnyNodeId } from '../schema/types'
import { DEFAULT_LEVEL_HEIGHT } from './level-height'
import { getLevelElevations } from './storey'
import {
  getStoreyOverviewRows,
  isStoreyHeightInRange,
  MAX_BATCH_LEVEL_COUNT,
  MAX_STOREY_HEIGHT,
  MIN_STOREY_HEIGHT,
  planBatchLevels,
  planLevelHeightUpdates,
  resolveAboveGroundBlockHeights,
  validateBatchLevelRequest,
} from './storey-batch'

const buildNodes = (list: AnyNode[]): Record<AnyNodeId, AnyNode> =>
  Object.fromEntries(list.map((node) => [node.id, node])) as Record<AnyNodeId, AnyNode>

const level = (
  id: string,
  ordinal: number,
  opts: { height?: number; parentId?: string | null; children?: string[] } = {},
): LevelNode =>
  LevelNode.parse({
    id,
    level: ordinal,
    parentId: opts.parentId ?? null,
    children: opts.children ?? [],
    ...(opts.height === undefined ? {} : { height: opts.height }),
  })

const building = (id: string, children: string[]): BuildingNode =>
  BuildingNode.parse({ id, children })

/**
 * Reads a patch as a plain record. `Partial<AnyNode>` is a union of every
 * kind's partial shape, so only the fields common to all kinds can be reached
 * without a narrowing cast.
 */
const patchOf = (update: { data: Partial<AnyNode> } | undefined): Record<string, unknown> =>
  (update?.data ?? {}) as Record<string, unknown>

const HEIGHTS = { ground: 3, standard: 2.8, basement: 2.6, top: 3.2 }

describe('isStoreyHeightInRange', () => {
  test('accepts the inclusive bounds and rejects anything outside', () => {
    expect(isStoreyHeightInRange(MIN_STOREY_HEIGHT)).toBe(true)
    expect(isStoreyHeightInRange(MAX_STOREY_HEIGHT)).toBe(true)
    expect(isStoreyHeightInRange(MIN_STOREY_HEIGHT - 0.01)).toBe(false)
    expect(isStoreyHeightInRange(MAX_STOREY_HEIGHT + 0.01)).toBe(false)
    expect(isStoreyHeightInRange(Number.NaN)).toBe(false)
  })
})

describe('resolveAboveGroundBlockHeights', () => {
  test('a single-level block is its own ground floor', () => {
    expect(resolveAboveGroundBlockHeights(1, HEIGHTS)).toEqual([3])
  })

  test('spreads ground / typical / top across a block', () => {
    expect(resolveAboveGroundBlockHeights(4, HEIGHTS)).toEqual([3, 2.8, 2.8, 3.2])
  })

  test('a two-level block has no typical floor', () => {
    expect(resolveAboveGroundBlockHeights(2, HEIGHTS)).toEqual([3, 3.2])
  })

  test('returns nothing for a non-positive count', () => {
    expect(resolveAboveGroundBlockHeights(0, HEIGHTS)).toEqual([])
  })
})

describe('validateBatchLevelRequest', () => {
  const empty = buildNodes([building('building_a', [])])

  test('rejects a request with no levels', () => {
    const errors = validateBatchLevelRequest(empty, {
      buildingId: 'building_a',
      aboveCount: 0,
      belowCount: 0,
      heights: HEIGHTS,
      mode: 'append',
    })
    expect(errors.length).toBeGreaterThan(0)
  })

  test('rejects an unknown building', () => {
    const errors = validateBatchLevelRequest(empty, {
      buildingId: 'building_missing',
      aboveCount: 1,
      belowCount: 0,
      heights: HEIGHTS,
      mode: 'append',
    })
    expect(errors[0]).toContain('building')
  })

  test('rejects heights outside the legal range', () => {
    const errors = validateBatchLevelRequest(empty, {
      buildingId: 'building_a',
      aboveCount: 2,
      belowCount: 0,
      heights: { ...HEIGHTS, standard: 1.8 },
      mode: 'append',
    })
    expect(errors.some((message) => message.includes('Typical floor height'))).toBe(true)
  })

  test('rejects more than the level cap', () => {
    const errors = validateBatchLevelRequest(empty, {
      buildingId: 'building_a',
      aboveCount: MAX_BATCH_LEVEL_COUNT,
      belowCount: 1,
      heights: HEIGHTS,
      mode: 'append',
    })
    expect(errors.some((message) => message.includes(String(MAX_BATCH_LEVEL_COUNT)))).toBe(true)
  })

  test('accepts a well-formed request', () => {
    expect(
      validateBatchLevelRequest(empty, {
        buildingId: 'building_a',
        aboveCount: 3,
        belowCount: 1,
        heights: HEIGHTS,
        mode: 'append',
      }),
    ).toEqual([])
  })
})

describe('planBatchLevels', () => {
  test('numbers an empty building from the ground floor up and basements down', () => {
    const nodes = buildNodes([building('building_a', [])])
    const plan = planBatchLevels(nodes, {
      buildingId: 'building_a',
      aboveCount: 3,
      belowCount: 2,
      heights: HEIGHTS,
      mode: 'append',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const ordinals = plan.result.createdLevelIds
      .map((id) => plan.result.changes.create.find((op) => op.node.id === id)?.node as LevelNode)
      .map((node) => node.level)
      .sort((a, b) => a - b)
    expect(ordinals).toEqual([-2, -1, 0, 1, 2])

    const heights = new Map(
      plan.result.changes.create
        .map((op) => op.node)
        .filter((node): node is LevelNode => node.type === 'level')
        .map((node) => [node.level, node.height] as const),
    )
    expect(heights.get(0)).toBe(3)
    expect(heights.get(1)).toBe(2.8)
    expect(heights.get(2)).toBe(3.2)
    expect(heights.get(-1)).toBe(2.6)
    expect(heights.get(-2)).toBe(2.6)
  })

  test('auto-supplies a ground floor when only basements are requested', () => {
    const nodes = buildNodes([building('building_a', [])])
    const plan = planBatchLevels(nodes, {
      buildingId: 'building_a',
      aboveCount: 0,
      belowCount: 2,
      heights: HEIGHTS,
      mode: 'append',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const ordinals = plan.result.changes.create
      .map((op) => (op.node as LevelNode).level)
      .sort((a, b) => a - b)
    expect(ordinals).toEqual([-2, -1, 0])
  })

  test('append stacks on top of the current top and below the current bottom', () => {
    const nodes = buildNodes([
      building('building_a', ['level_0', 'level_1', 'level_m1']),
      level('level_m1', -1, { parentId: 'building_a' }),
      level('level_0', 0, { parentId: 'building_a' }),
      level('level_1', 1, { parentId: 'building_a' }),
    ])
    const plan = planBatchLevels(nodes, {
      buildingId: 'building_a',
      aboveCount: 2,
      belowCount: 1,
      heights: HEIGHTS,
      mode: 'append',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const ordinals = plan.result.changes.create
      .map((op) => (op.node as LevelNode).level)
      .sort((a, b) => a - b)
    expect(ordinals).toEqual([-2, 2, 3])
    expect(plan.result.changes.delete).toEqual([])
  })

  test('rebuild deletes the existing levels and re-anchors at zero', () => {
    const nodes = buildNodes([
      building('building_a', ['level_0', 'level_1']),
      level('level_0', 0, { parentId: 'building_a' }),
      level('level_1', 1, { parentId: 'building_a' }),
    ])
    const plan = planBatchLevels(nodes, {
      buildingId: 'building_a',
      aboveCount: 4,
      belowCount: 1,
      heights: HEIGHTS,
      mode: 'rebuild',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.result.changes.delete.sort()).toEqual(['level_0', 'level_1'])
    const ordinals = plan.result.changes.create
      .map((op) => (op.node as LevelNode).level)
      .sort((a, b) => a - b)
    expect(ordinals).toEqual([-1, 0, 1, 2, 3])
  })

  test('a rejected request plans nothing', () => {
    const nodes = buildNodes([building('building_a', [])])
    const plan = planBatchLevels(nodes, {
      buildingId: 'building_a',
      aboveCount: 2,
      belowCount: 0,
      heights: { ...HEIGHTS, ground: 12 },
      mode: 'append',
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.errors.length).toBeGreaterThan(0)
  })
})

describe('planLevelHeightUpdates', () => {
  test('shifts the level and leaves the stack above to the pure resolver', () => {
    const nodes = buildNodes([
      building('building_a', ['level_0', 'level_1']),
      level('level_0', 0, { height: 2.5, parentId: 'building_a' }),
      level('level_1', 1, { height: 2.5, parentId: 'building_a' }),
    ])
    const plan = planLevelHeightUpdates(nodes, ['level_0'], 3.5)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    // Only the edited level is written — the one above translates because
    // getLevelElevations derives its baseY from the stored heights.
    expect(plan.result.update).toEqual([{ id: 'level_0', data: { height: 3.5 } }])

    const nextNodes = buildNodes([
      building('building_a', ['level_0', 'level_1']),
      level('level_0', 0, { height: 3.5, parentId: 'building_a' }),
      level('level_1', 1, { height: 2.5, parentId: 'building_a' }),
    ])
    const elevations = getLevelElevations(nextNodes)
    expect(elevations.get('level_1')?.baseY).toBeCloseTo(3.5, 6)
  })

  test('re-pins an explicit-height wall that was tracking the plane', () => {
    const wall = WallNode.parse({
      id: 'wall_a',
      start: [0, 0],
      end: [4, 0],
      height: 2.5,
      parentId: 'level_0',
    })
    const nodes = buildNodes([
      building('building_a', ['level_0']),
      level('level_0', 0, { height: 2.5, parentId: 'building_a', children: ['wall_a'] }),
      wall,
    ])
    const plan = planLevelHeightUpdates(nodes, ['level_0'], 3)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const wallUpdate = plan.result.update.find((entry) => entry.id === 'wall_a')
    expect(patchOf(wallUpdate).height).toBeCloseTo(3, 6)
  })

  test('leaves a half wall alone', () => {
    const wall = WallNode.parse({
      id: 'wall_a',
      start: [0, 0],
      end: [4, 0],
      height: 1.1,
      parentId: 'level_0',
    })
    const nodes = buildNodes([
      building('building_a', ['level_0']),
      level('level_0', 0, { height: 2.5, parentId: 'building_a', children: ['wall_a'] }),
      wall,
    ])
    const plan = planLevelHeightUpdates(nodes, ['level_0'], 3)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.result.update.some((entry) => entry.id === 'wall_a')).toBe(false)
  })

  test('follows the clamp bound for a tracking ceiling', () => {
    const ceiling = CeilingNode.parse({
      id: 'ceiling_a',
      polygon: [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      height: 2.49,
      parentId: 'level_0',
    })
    const nodes = buildNodes([
      building('building_a', ['level_0']),
      level('level_0', 0, { height: 2.5, parentId: 'building_a', children: ['ceiling_a'] }),
      ceiling,
    ])
    const plan = planLevelHeightUpdates(nodes, ['level_0'], 3)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const ceilingUpdate = plan.result.update.find((entry) => entry.id === 'ceiling_a')
    expect(patchOf(ceilingUpdate).height).toBeCloseTo(2.99, 6)
  })

  test('rewrites a tracking stair rise and scales its flights', () => {
    const stair = StairNode.parse({
      id: 'stair_a',
      position: [0, 0, 0],
      rotation: 0,
      stairType: 'straight',
      totalRise: 2.5,
      parentId: 'level_0',
      children: ['sseg_a'],
    })
    const flight = StairSegmentNode.parse({
      id: 'sseg_a',
      segmentType: 'stair',
      height: 2.5,
      parentId: 'stair_a',
    })
    const nodes = buildNodes([
      building('building_a', ['level_0']),
      level('level_0', 0, { height: 2.5, parentId: 'building_a', children: ['stair_a'] }),
      stair,
      flight,
    ])
    const plan = planLevelHeightUpdates(nodes, ['level_0'], 5)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(
      patchOf(plan.result.update.find((entry) => entry.id === 'stair_a')).totalRise,
    ).toBeCloseTo(5, 6)
    expect(patchOf(plan.result.update.find((entry) => entry.id === 'sseg_a')).height).toBeCloseTo(
      5,
      6,
    )
  })

  test('leaves a hand-authored rise alone', () => {
    const stair = StairNode.parse({
      id: 'stair_a',
      position: [0, 0, 0],
      rotation: 0,
      stairType: 'straight',
      totalRise: 1.2,
      parentId: 'level_0',
    })
    const nodes = buildNodes([
      building('building_a', ['level_0']),
      level('level_0', 0, { height: 2.5, parentId: 'building_a', children: ['stair_a'] }),
      stair,
    ])
    const plan = planLevelHeightUpdates(nodes, ['level_0'], 3)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.result.update.some((entry) => entry.id === 'stair_a')).toBe(false)
  })

  test('enforces the batch range only when asked', () => {
    const nodes = buildNodes([
      building('building_a', ['level_0']),
      level('level_0', 0, { height: 2.5, parentId: 'building_a' }),
    ])
    expect(planLevelHeightUpdates(nodes, ['level_0'], 12).ok).toBe(true)
    expect(planLevelHeightUpdates(nodes, ['level_0'], 12, { enforceHeightRange: true }).ok).toBe(
      false,
    )
  })
})

describe('getStoreyOverviewRows', () => {
  test('reports cumulative base elevations and per-level counts', () => {
    const wall = WallNode.parse({ id: 'wall_a', start: [0, 0], end: [4, 0], parentId: 'level_1' })
    const slab = SlabNode.parse({
      id: 'slab_a',
      polygon: [
        [0, 0],
        [4, 0],
        [4, 4],
      ],
      parentId: 'level_1',
    })
    const nodes = buildNodes([
      building('building_a', ['level_m1', 'level_0', 'level_1']),
      level('level_m1', -1, {
        height: 2.6,
        parentId: 'building_a',
      }),
      level('level_0', 0, { height: 3, parentId: 'building_a' }),
      level('level_1', 1, {
        height: 2.8,
        parentId: 'building_a',
        children: ['wall_a', 'slab_a'],
      }),
      wall,
      slab,
    ])

    const rows = getStoreyOverviewRows(nodes, 'building_a')
    expect(rows.map((row) => row.ordinal)).toEqual([1, 0, -1])
    expect(rows[0]?.wallCount).toBe(1)
    expect(rows[0]?.slabCount).toBe(1)
    expect(rows[0]?.itemCount).toBe(0)
    // The stack is cumulative from the lowest level up: the basement floor is
    // the datum at 0, the ground floor rides on top of the basement's 2.6 m,
    // and the first floor on the ground floor's 3 m.
    expect(rows[2]?.baseY).toBeCloseTo(0, 6)
    expect(rows[1]?.baseY).toBeCloseTo(2.6, 6)
    expect(rows[0]?.baseY).toBeCloseTo(5.6, 6)
    expect(rows[0]?.topY).toBeCloseTo(8.4, 6)
  })

  test('returns nothing without a building', () => {
    expect(getStoreyOverviewRows({}, null)).toEqual([])
  })

  test('falls back to the default height for unmigrated levels', () => {
    const nodes = buildNodes([
      building('building_a', ['level_0']),
      level('level_0', 0, { parentId: 'building_a' }),
    ])
    expect(getStoreyOverviewRows(nodes, 'building_a')[0]?.height).toBe(DEFAULT_LEVEL_HEIGHT)
  })
})
