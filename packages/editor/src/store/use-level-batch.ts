import type { AnyNodeId, LevelNode } from '@pascal-app/core'
import { create } from 'zustand'

type PendingBatchLevelRequest = {
  buildingId: AnyNodeId
  /** Opens the dialog straight in "rebuild" confirmation mode. */
  initialMode?: 'append' | 'rebuild'
}

type LevelBatchState = {
  /** Building the batch-level dialog is open for (`null` when closed). */
  batchDialog: PendingBatchLevelRequest | null
  /** Levels ticked for a multi-level height edit. */
  selectedLevelIds: AnyNodeId[]
  /** Level whose typical-floor instance count is being requested. */
  typicalDerive: { masterLevelId: AnyNodeId } | null
  /** Last error surfaced by a batch action, for the toast/inline banner. */
  lastError: string | null

  openBatchDialog: (buildingId: AnyNodeId, initialMode?: 'append' | 'rebuild') => void
  closeBatchDialog: () => void

  openTypicalDerive: (masterLevelId: AnyNodeId) => void
  closeTypicalDerive: () => void

  isLevelSelected: (levelId: AnyNodeId) => boolean
  toggleLevelSelected: (levelId: AnyNodeId) => void
  setSelectedLevels: (levelIds: AnyNodeId[]) => void
  clearSelectedLevels: () => void

  setLastError: (message: string | null) => void
}

/**
 * Editor-only session state for the multi-storey toolset: which dialog is
 * open and which levels are ticked for a batch height edit. Deliberately not
 * part of `useEditor`'s persisted layout slice — none of it should survive a
 * reload.
 */
export const useLevelBatch = create<LevelBatchState>((set, get) => ({
  batchDialog: null,
  selectedLevelIds: [],
  typicalDerive: null,
  lastError: null,

  openBatchDialog: (buildingId, initialMode = 'append') =>
    set({ batchDialog: { buildingId, initialMode }, lastError: null }),
  closeBatchDialog: () => set({ batchDialog: null }),

  openTypicalDerive: (masterLevelId) => set({ typicalDerive: { masterLevelId }, lastError: null }),
  closeTypicalDerive: () => set({ typicalDerive: null }),

  isLevelSelected: (levelId) => get().selectedLevelIds.includes(levelId),
  toggleLevelSelected: (levelId) =>
    set((state) => ({
      selectedLevelIds: state.selectedLevelIds.includes(levelId)
        ? state.selectedLevelIds.filter((id) => id !== levelId)
        : [...state.selectedLevelIds, levelId],
    })),
  setSelectedLevels: (levelIds) => set({ selectedLevelIds: [...levelIds] }),
  clearSelectedLevels: () => set({ selectedLevelIds: [] }),

  setLastError: (message) => set({ lastError: message }),
}))

/**
 * Drops level ids that no longer exist (a level deleted or undone away) so a
 * stale tick can never resurrect into a batch edit.
 */
export function pruneSelectedLevels(levels: LevelNode[]): void {
  const validIds = new Set<string>(levels.map((level) => level.id))
  const current = useLevelBatch.getState().selectedLevelIds
  const next = current.filter((id) => validIds.has(id))
  if (next.length !== current.length) {
    useLevelBatch.getState().setSelectedLevels(next as AnyNodeId[])
  }
}
