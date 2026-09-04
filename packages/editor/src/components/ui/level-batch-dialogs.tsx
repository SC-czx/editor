'use client'

import { BatchLevelDialog } from './batch-level-dialog'
import { TypicalFloorDialog } from './typical-floor-dialog'

/**
 * Single mount point for the multi-storey dialogs.
 *
 * Kept out of `FloatingLevelSelector` on purpose: that component bails out
 * when the building has no levels, which is exactly when "batch create" is
 * needed most. Radix renders through a portal, so mounting it in the sidebar
 * is enough for the dialogs to escape every stacking context.
 */
export function LevelBatchDialogs() {
  return (
    <>
      <BatchLevelDialog />
      <TypicalFloorDialog />
    </>
  )
}
