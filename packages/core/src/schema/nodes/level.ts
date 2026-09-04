import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'
import type { BlockNode } from './block'
import type { CeilingNode } from './ceiling'
import type { ColumnNode } from './column'
import type { ConstructionDimensionNode } from './construction-dimension'
import type { DuctFittingNode } from './duct-fitting'
import type { DuctSegmentNode } from './duct-segment'
import type { DuctTerminalNode } from './duct-terminal'
import type { FenceNode } from './fence'
import type { GuideNode } from './guide'
import type { HvacEquipmentNode } from './hvac-equipment'
import type { ItemNode } from './item'
import type { LinesetNode } from './lineset'
import type { LiquidLineNode } from './liquid-line'
import type { MeasurementNode } from './measurement'
import type { PipeFittingNode } from './pipe-fitting'
import type { PipeSegmentNode } from './pipe-segment'
import type { PipeTrapNode } from './pipe-trap'
import type { RoofNode } from './roof'
import type { ScanNode } from './scan'
import type { ShelfNode } from './shelf'
import type { SlabNode } from './slab'
import type { SpawnNode } from './spawn'
import type { StairNode } from './stair'
import type { StructuralGridNode } from './structural-grid'
import type { WallNode } from './wall'
import type { ZoneNode } from './zone'

type CoreLevelChildId =
  | WallNode['id']
  | FenceNode['id']
  | ColumnNode['id']
  | ConstructionDimensionNode['id']
  | BlockNode['id']
  | StructuralGridNode['id']
  | ItemNode['id']
  | ZoneNode['id']
  | SlabNode['id']
  | CeilingNode['id']
  | RoofNode['id']
  | StairNode['id']
  | ScanNode['id']
  | GuideNode['id']
  | MeasurementNode['id']
  | SpawnNode['id']
  | ShelfNode['id']
  | DuctSegmentNode['id']
  | DuctFittingNode['id']
  | DuctTerminalNode['id']
  | HvacEquipmentNode['id']
  | LinesetNode['id']
  | LiquidLineNode['id']
  | PipeSegmentNode['id']
  | PipeFittingNode['id']
  | PipeTrapNode['id']

const LevelChildId = z.string().transform((id) => id as CoreLevelChildId)

export const DEFAULT_LEVEL_BASE_ELEVATION = 0

/**
 * Marks the level as a typical-floor master: its structural content is the
 * source of truth for every level derived from it.
 *
 * No zod default on purpose (same rule as `height`): absence is data, and a
 * default would materialize on `.parse()` for levels that were never marked.
 */
export const TYPICAL_MASTER_FIELD = 'typicalMaster' as const

/** Back-reference from a derived typical-floor instance to its master. */
export const TYPICAL_MASTER_ID_FIELD = 'typicalMasterId' as const

export function normalizeLevelBaseElevation(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LEVEL_BASE_ELEVATION
}

export const LevelNode = BaseNode.extend({
  id: objectId('level'),
  type: nodeType('level'),
  // The node registry owns child-kind validity. Persisted level relationships
  // must also admit IDs minted by plugins that core cannot enumerate.
  children: z.array(LevelChildId).default([]),
  // Specific props
  level: z.number().default(0),
  baseElevation: z
    .number()
    .default(DEFAULT_LEVEL_BASE_ELEVATION)
    .describe("Additive Y offset in meters applied above this level's computed stack position."),
  /**
   * Stored storey height in meters (floor-to-floor). No zod default on
   * purpose: absence marks unmigrated legacy data and gates the load-time
   * migration; a schema default would materialize silently through .parse().
   */
  height: z.number().optional(),
  /**
   * Typical-floor master flag. When `true` this level's structural content is
   * the source of truth for every level whose `typicalMasterId` points here.
   * Absent means an ordinary level.
   */
  typicalMaster: z.boolean().optional(),
  /**
   * For a typical-floor instance: the id of the master level it was derived
   * from. Absent means the level is not an instance. A level is never both a
   * master and an instance — the load-time migration drops the contradiction.
   */
  typicalMasterId: z.string().optional(),
}).describe(
  dedent`
  Level node - used to represent a level in the building
  - children: array of architectural, equipment, and MEP distribution nodes
  - level: level number
  - baseElevation: additive Y offset in meters above the computed stack position
  - height: storey height in meters (floor-to-floor); absent only on unmigrated legacy data
  - typicalMaster: true when this level is a typical-floor master
  - typicalMasterId: for a derived instance, the master level's id
  `,
)

export type LevelNode = z.infer<typeof LevelNode>
