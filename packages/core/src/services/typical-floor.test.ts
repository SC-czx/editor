import { describe, expect, test } from 'bun:test'
import { BuildingNode, ItemNode, LevelNode, ScanNode, WallNode, WindowNode } from '../schema'
import type { AnyNode, AnyNodeId } from '../schema/types'
import { migrateVerticalSceneNodes } from '../utils/vertical-scene-migration'
import {
  findTypicalInstanceIds,
  getTypicalMasterId,
  isTypicalInstance,
  isTypicalMaster,
  planDetachTypicalInstances,
  planSetTypicalMaster,
  planSyncTypicalFloorInstances,
  planTypicalFloorInstances,
} from './typical-floor'

const buildNodes = (list: AnyNode[]): Record<AnyNodeId, AnyNode> =>
  Object.fromEntries(list.map((node) => [node.id, node])) as Record<AnyNodeId, AnyNode>

const level = (
  id: string,
  ordinal: number,
  opts: {
    height?: number
    parentId?: string | null
    children?: string[]
    typicalMaster?: boolean
    typicalMasterId?: string
    name?: string
  } = {},
): LevelNode =>
  LevelNode.parse({
    id,
    level: ordinal,
    parentId: opts.parentId ?? null,
    children: opts.children ?? [],
    ...(opts.height === undefined ? {} : { height: opts.height }),
    ...(opts.typicalMaster === undefined ? {} : { typicalMaster: opts.typicalMaster }),
    ...(opts.typicalMasterId === undefined ? {} : { typicalMasterId: opts.typicalMasterId }),
    ...(opts.name === undefined ? {} : { name: opts.name }),
  })

const building = (id: string, children: string[]): BuildingNode =>
  BuildingNode.parse({ id, children })

/**
 * Reads a patch as a plain record — `Partial<AnyNode>` is a union across every
 * kind, so only fields common to all kinds are reachable without a cast.
 */
const patchOf = (update: { data: Partial<AnyNode> } | undefined): Record<string, unknown> =>
  (update?.data ?? {}) as Record<string, unknown>

const wall = (id: string, parentId: string, children: string[] = []): WallNode =>
  WallNode.parse({ id, start: [0, 0], end: [4, 0], parentId, children })

const windowOn = (id: string, wallId: string, parentId: string): WindowNode =>
  WindowNode.parse({ id, wallId, parentId, position: [2, 1, 0], width: 1, height: 1.2 })

const scan = (id: string, parentId: string): ScanNode =>
  ScanNode.parse({ id, url: '/scan.glb', parentId })

const furniture = (id: string, parentId: string): ItemNode =>
  ItemNode.parse({
    id,
    parentId,
    position: [1, 0, 1],
    asset: {
      id: 'sofa',
      category: 'seating',
      name: 'Sofa',
      thumbnail: '/sofa.webp',
      src: '/sofa.glb',
    },
  })

/** A master level carrying one wall with one window, plus a scan to drop. */
function masterScene() {
  return buildNodes([
    building('building_a', ['level_0']),
    level('level_0', 0, {
      height: 3,
      parentId: 'building_a',
      children: ['wall_a', 'scan_a'],
      typicalMaster: true,
    }),
    wall('wall_a', 'level_0', ['window_a']),
    windowOn('window_a', 'wall_a', 'level_0'),
    scan('scan_a', 'level_0'),
  ])
}

describe('typical floor predicates', () => {
  test('reads the master flag and the instance back-reference', () => {
    const master = level('level_0', 0, { typicalMaster: true })
    const instance = level('level_1', 1, { typicalMasterId: 'level_0' })
    const plain = level('level_2', 2)

    expect(isTypicalMaster(master)).toBe(true)
    expect(isTypicalInstance(master)).toBe(false)
    expect(isTypicalInstance(instance)).toBe(true)
    expect(getTypicalMasterId(instance)).toBe('level_0')
    expect(getTypicalMasterId(plain)).toBeNull()
    expect(isTypicalMaster(plain)).toBe(false)
    expect(isTypicalInstance(plain)).toBe(false)
  })

  test('finds instances ordered by ordinal', () => {
    const nodes = buildNodes([
      level('level_1', 1, { typicalMasterId: 'level_0' }),
      level('level_3', 3, { typicalMasterId: 'level_0' }),
      level('level_2', 2, { typicalMasterId: 'level_0' }),
      level('level_0', 0, { typicalMaster: true }),
    ])
    expect(findTypicalInstanceIds(nodes, 'level_0')).toEqual(['level_1', 'level_2', 'level_3'])
  })
})

describe('planTypicalFloorInstances', () => {
  test('inserts instances above the master, shifts higher levels, and copies content', () => {
    const nodes = buildNodes([
      building('building_a', ['level_0', 'level_1']),
      level('level_0', 0, {
        height: 3,
        parentId: 'building_a',
        children: ['wall_a', 'scan_a'],
        typicalMaster: true,
      }),
      level('level_1', 1, { height: 3, parentId: 'building_a' }),
      wall('wall_a', 'level_0', ['window_a']),
      windowOn('window_a', 'wall_a', 'level_0'),
      scan('scan_a', 'level_0'),
    ])

    const plan = planTypicalFloorInstances(nodes, {
      masterLevelId: 'level_0',
      instanceCount: 2,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const { changes, createdLevelIds } = plan.result
    expect(createdLevelIds).toHaveLength(2)

    const instanceLevels = changes.create
      .map((op) => op.node)
      .filter((node): node is LevelNode => node.type === 'level')
    expect(instanceLevels.map((node) => node.level)).toEqual([1, 2])
    for (const instance of instanceLevels) {
      expect(instance.typicalMasterId).toBe('level_0')
      expect(instance.typicalMaster).toBeUndefined()
      expect(instance.height).toBe(3)
    }

    // The pre-existing level 1 is pushed above both new instances.
    const shifted = changes.update.find((entry) => entry.id === 'level_1')
    expect(patchOf(shifted).level).toBe(3)

    // Content: wall + window per instance, never the scan.
    const createdTypes = changes.create
      .filter((op) => op.node.type !== 'level')
      .map((op) => op.node.type)
    expect(createdTypes.filter((type) => type === 'wall')).toHaveLength(2)
    expect(createdTypes.filter((type) => type === 'window')).toHaveLength(2)
    expect(createdTypes).not.toContain('scan')

    // Every cloned wall is parented to a different instance.
    const wallParents = changes.create
      .filter((op) => op.node.type === 'wall')
      .map((op) => op.parentId)
    expect(new Set(wallParents).size).toBe(2)
  })

  test('rejects a non-level master and a non-positive count', () => {
    const nodes = masterScene()
    expect(planTypicalFloorInstances(nodes, { masterLevelId: 'wall_a', instanceCount: 1 }).ok).toBe(
      false,
    )
    expect(
      planTypicalFloorInstances(nodes, { masterLevelId: 'level_0', instanceCount: 0 }).ok,
    ).toBe(false)
  })
})

describe('planSyncTypicalFloorInstances', () => {
  test('replaces inherited structure and keeps furniture added to an instance', () => {
    const nodes = buildNodes([
      building('building_a', ['level_0', 'level_1']),
      level('level_0', 0, {
        height: 3,
        parentId: 'building_a',
        children: ['wall_a'],
        typicalMaster: true,
      }),
      level('level_1', 1, {
        height: 3,
        parentId: 'building_a',
        children: ['wall_old', 'item_a'],
        typicalMasterId: 'level_0',
      }),
      wall('wall_a', 'level_0', ['window_a']),
      windowOn('window_a', 'wall_a', 'level_0'),
      // Stale structure from an earlier sync.
      wall('wall_old', 'level_1'),
      // Furniture the user added after deriving the instance.
      furniture('item_a', 'level_1'),
    ])

    const plan = planSyncTypicalFloorInstances(nodes, 'level_0')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    // The stale wall goes; the user's item stays.
    expect(plan.result.delete).toContain('wall_old')
    expect(plan.result.delete).not.toContain('item_a')

    // A fresh wall + window is grafted onto the instance.
    const created = plan.result.create
    expect(created.filter((op) => op.node.type === 'wall')).toHaveLength(1)
    expect(created.filter((op) => op.node.type === 'window')).toHaveLength(1)
    for (const op of created) {
      if (op.node.type === 'wall') expect(op.parentId).toBe('level_1')
    }
  })

  test('refuses to sync a level that is not a master', () => {
    const nodes = buildNodes([
      level('level_0', 0),
      level('level_1', 1, { typicalMasterId: 'level_0' }),
    ])
    expect(planSyncTypicalFloorInstances(nodes, 'level_0').ok).toBe(false)
  })

  test('refuses to sync a master with no instances', () => {
    const nodes = buildNodes([level('level_0', 0, { typicalMaster: true })])
    expect(planSyncTypicalFloorInstances(nodes, 'level_0').ok).toBe(false)
  })
})

describe('planDetachTypicalInstances / planSetTypicalMaster', () => {
  test('unmarking a master detaches its instances', () => {
    const nodes = buildNodes([
      level('level_0', 0, { typicalMaster: true }),
      level('level_1', 1, { typicalMasterId: 'level_0' }),
      level('level_2', 2, { typicalMasterId: 'level_0' }),
    ])
    const plan = planSetTypicalMaster(nodes, { levelId: 'level_0', isMaster: false })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.result.update).toEqual([
      { id: 'level_1', data: { typicalMasterId: undefined } },
      { id: 'level_2', data: { typicalMasterId: undefined } },
      { id: 'level_0', data: { typicalMaster: undefined } },
    ])
  })

  test('marking a master clears any stale back-reference on that level', () => {
    const nodes = buildNodes([level('level_0', 0, { typicalMasterId: 'level_gone' })])
    const plan = planSetTypicalMaster(nodes, { levelId: 'level_0', isMaster: true })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.result.update).toEqual([
      { id: 'level_0', data: { typicalMaster: true, typicalMasterId: undefined } },
    ])
  })

  test('detach only touches the instances of the given master', () => {
    const nodes = buildNodes([
      level('level_0', 0, { typicalMaster: true }),
      level('level_1', 1, { typicalMasterId: 'level_0' }),
      level('level_2', 2, { typicalMasterId: 'level_other' }),
    ])
    expect(planDetachTypicalInstances(nodes, 'level_0').update).toEqual([
      { id: 'level_1', data: { typicalMasterId: undefined } },
    ])
  })
})

describe('typical-floor load migration', () => {
  // `height` is present on every level so the scene is not classified as
  // legacy — otherwise the height-materialization pass alone would report a
  // change and mask what these assertions are about.
  const stored = (node: LevelNode) => ({ ...node, type: 'level', object: 'node' })

  test('drops a dangling back-reference', () => {
    const migrated = migrateVerticalSceneNodes({
      level_0: stored(level('level_0', 0, { height: 3 })),
      level_1: stored(level('level_1', 1, { height: 3, typicalMasterId: 'level_deleted' })),
    })
    expect('typicalMasterId' in (migrated.nodes.level_1 as Record<string, unknown>)).toBe(false)
  })

  test('drops a self-referential back-reference', () => {
    const migrated = migrateVerticalSceneNodes({
      level_0: stored(level('level_0', 0, { height: 3, typicalMasterId: 'level_0' })),
    })
    expect('typicalMasterId' in (migrated.nodes.level_0 as Record<string, unknown>)).toBe(false)
  })

  test('a master keeps its flag and loses any back-reference', () => {
    const migrated = migrateVerticalSceneNodes({
      level_0: stored(level('level_0', 0, { height: 3, typicalMaster: true })),
      level_1: stored(
        level('level_1', 1, { height: 3, typicalMaster: true, typicalMasterId: 'level_0' }),
      ),
    })
    const master = migrated.nodes.level_1 as Record<string, unknown>
    expect(master.typicalMaster).toBe(true)
    expect('typicalMasterId' in master).toBe(false)
  })

  test('preserves a well-formed link and is idempotent', () => {
    const source = {
      level_0: stored(level('level_0', 0, { height: 3, typicalMaster: true })),
      level_1: stored(level('level_1', 1, { height: 3, typicalMasterId: 'level_0' })),
    }
    const once = migrateVerticalSceneNodes(source)
    expect(once.changed).toBe(false)
    expect((once.nodes.level_1 as Record<string, unknown>).typicalMasterId).toBe('level_0')

    const twice = migrateVerticalSceneNodes(once.nodes as Record<string, unknown>)
    expect(twice.changed).toBe(false)
  })
})
