import {
  type AnyNodeId,
  type BatchLevelHeights,
  type BatchLevelMode,
  type BatchLevelRequest,
  type LevelNode,
  planBatchLevels,
  planDetachTypicalInstances,
  planLevelHeightUpdates,
  planSetTypicalMaster,
  planSyncTypicalFloorInstances,
  planTypicalFloorInstances,
  runAsSingleSceneHistoryStep,
  type StoreyBatchChange,
  useScene,
} from '@pascal-app/core'

export type BatchActionResult = { ok: boolean; errors: string[] }

const OK: BatchActionResult = { ok: true, errors: [] }

function fail(errors: string[]): BatchActionResult {
  return { ok: false, errors }
}

/**
 * Applies a whole batch of scene mutations as one store write, and therefore
 * one undo entry.
 *
 * `runAsSingleSceneHistoryStep` additionally swallows the history entries the
 * reactive systems add right after the write (stair rise sync, auto
 * openings) — those run a microtask later with history paused, so a single
 * undo lands back on the pre-batch scene rather than on an intermediate
 * state where half the levels exist.
 */
function applyStoreyChange(run: () => void): void {
  runAsSingleSceneHistoryStep(useScene, run)
}

function applyChanges(changes: StoreyBatchChange): void {
  const { create, update, delete: remove } = changes
  if (create.length === 0 && update.length === 0 && remove.length === 0) return
  useScene.getState().applyNodeChanges({ create, update, delete: remove })
}

export type RunBatchLevelsInput = {
  buildingId: AnyNodeId
  aboveCount: number
  belowCount: number
  heights: BatchLevelHeights
  mode: BatchLevelMode
}

/**
 * Batch-creates a block of levels on one building.
 *
 * Validation runs against the live scene before anything is written, so a
 * rejected request cannot leave a half-built stack behind.
 *
 * @returns the created level ids (topmost last) for the caller to select.
 */
export function runBatchLevels(
  input: RunBatchLevelsInput,
): BatchActionResult & { createdLevelIds: AnyNodeId[] } {
  const nodes = useScene.getState().nodes
  const request: BatchLevelRequest = {
    buildingId: input.buildingId,
    aboveCount: input.aboveCount,
    belowCount: input.belowCount,
    heights: input.heights,
    mode: input.mode,
  }

  const planned = planBatchLevels(nodes, request)
  if (!planned.ok) return { ...fail(planned.errors), createdLevelIds: [] }

  const createdLevelIds = planned.result.createdLevelIds
  applyStoreyChange(() => applyChanges(planned.result.changes))
  return { ...OK, createdLevelIds }
}

/**
 * Writes one height onto every ticked level, plus the geometry that has to
 * follow the plane (walls, ceilings, stairs). Levels above the edited ones
 * are not touched: the storey stack derives their elevation from the stored
 * heights, so they translate on their own.
 */
export function runBatchLevelHeight(
  levelIds: AnyNodeId[],
  height: number,
  options: { enforceHeightRange?: boolean } = {},
): BatchActionResult {
  if (levelIds.length === 0) return fail(['Select at least one level first.'])

  const nodes = useScene.getState().nodes
  const planned = planLevelHeightUpdates(nodes, levelIds, height, options)
  if (!planned.ok) return fail(planned.errors)

  applyStoreyChange(() => applyChanges(planned.result))
  return OK
}

/** Sets a single level's height with the same plane-following linkage. */
export function runLevelHeight(levelId: AnyNodeId, height: number): BatchActionResult {
  return runBatchLevelHeight([levelId], height)
}

/**
 * Derives typical-floor instances from a master level. Instances land
 * directly above the master and start life as a full copy of its content.
 */
export function runDeriveTypicalInstances(
  masterLevelId: AnyNodeId,
  instanceCount: number,
): BatchActionResult & { createdLevelIds: AnyNodeId[] } {
  const nodes = useScene.getState().nodes
  const planned = planTypicalFloorInstances(nodes, {
    masterLevelId,
    instanceCount,
  })
  if (!planned.ok) return { ...fail(planned.errors), createdLevelIds: [] }

  const createdLevelIds = planned.result.createdLevelIds
  applyStoreyChange(() => applyChanges(planned.result.changes))
  return { ...OK, createdLevelIds }
}

/**
 * Pushes the master's current structural content onto every instance.
 * Furniture, reference imagery and annotations on the instances survive.
 */
export function runSyncTypicalInstances(masterLevelId: AnyNodeId): BatchActionResult {
  const nodes = useScene.getState().nodes
  const planned = planSyncTypicalFloorInstances(nodes, masterLevelId)
  if (!planned.ok) return fail(planned.errors)

  applyStoreyChange(() => applyChanges(planned.result))
  return OK
}

/** Marks or unmarks a level as a typical-floor master. */
export function runSetTypicalMaster(levelId: AnyNodeId, isMaster: boolean): BatchActionResult {
  const nodes = useScene.getState().nodes
  const planned = planSetTypicalMaster(nodes, { levelId, isMaster })
  if (!planned.ok) return fail(planned.errors)

  applyStoreyChange(() => applyChanges(planned.result))
  return OK
}

/**
 * Deletes a level and, when it was a typical-floor master, turns every
 * instance back into an ordinary level in the same undo step.
 *
 * Callers own the selection fallback; this only guarantees the scene graph
 * stays consistent.
 */
export function deleteLevelWithTypicalDetach(levelId: AnyNodeId): void {
  const nodes = useScene.getState().nodes
  const level = nodes[levelId] as LevelNode | undefined
  const detach =
    level?.type === 'level' && level.typicalMaster === true
      ? planDetachTypicalInstances(nodes, levelId)
      : null

  applyStoreyChange(() => {
    if (detach) applyChanges(detach)
    useScene.getState().deleteNode(levelId)
  })
}
