'use client'

import {
  countTypicalInstances,
  getLevelDisplayName,
  type LevelNode,
  MAX_BATCH_LEVEL_COUNT,
  useScene,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { AlertTriangle, CopyPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'
import { runDeriveTypicalInstances } from '../../lib/level-batch-actions'
import { useLevelBatch } from '../../store/use-level-batch'
import { ActionButton } from './controls/action-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './primitives/dialog'

/**
 * Asks how many typical-floor instances to derive from a master level.
 *
 * The copies land directly above the master (like the single-level duplicate
 * flow) and start life as a full copy of its walls, floors, ceilings and
 * openings — minus scans, guides and spawn anchors.
 */
export function TypicalFloorDialog() {
  const request = useLevelBatch((state) => state.typicalDerive)
  const closeTypicalDerive = useLevelBatch((state) => state.closeTypicalDerive)
  const setSelection = useViewer((state) => state.setSelection)

  const [count, setCount] = useState('1')
  const [errors, setErrors] = useState<string[]>([])

  const masterLevelId = request?.masterLevelId ?? null
  const master = useScene((state) =>
    masterLevelId ? ((state.nodes[masterLevelId] as LevelNode | undefined) ?? null) : null,
  )
  const nodes = useScene((state) => state.nodes)
  const instanceCount = masterLevelId ? countTypicalInstances(nodes, masterLevelId) : 0

  useEffect(() => {
    if (!request) return
    setCount('1')
    setErrors([])
  }, [request])

  if (!request || !masterLevelId || !master) return null

  const parsed = Number.parseInt(count, 10)
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_BATCH_LEVEL_COUNT

  const handleSubmit = () => {
    if (!valid) {
      setErrors([`Enter a number between 1 and ${MAX_BATCH_LEVEL_COUNT}.`])
      return
    }
    const result = runDeriveTypicalInstances(masterLevelId, parsed)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    const lastId = result.createdLevelIds.at(-1)
    if (lastId) {
      setSelection({ levelId: lastId as LevelNode['id'] })
    }
    closeTypicalDerive()
  }

  return (
    <Dialog onOpenChange={(open) => !open && closeTypicalDerive()} open>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CopyPlus className="h-4 w-4" />
            Derive typical floors
          </DialogTitle>
          <DialogDescription>
            Copy {getLevelDisplayName(master)}'s structure into new levels stacked directly above
            it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">Number of instances</span>
            <input
              className="w-full rounded-lg border border-border/60 bg-accent/30 px-2.5 py-1.5 text-foreground text-sm outline-none focus:border-primary"
              max={MAX_BATCH_LEVEL_COUNT}
              min={1}
              onChange={(e) => setCount(e.target.value)}
              step={1}
              type="number"
              value={count}
            />
          </label>

          <p className="text-muted-foreground text-xs">
            Walls, slabs, ceilings and openings are copied; scans, guides and spawn anchors are
            not. Each instance keeps its own furniture — a later sync never clears it.
          </p>

          {instanceCount > 0 && (
            <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <AlertTriangle className="h-3 w-3" />
              This master already has {instanceCount} instance
              {instanceCount === 1 ? '' : 's'}.
            </p>
          )}

          {errors.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5">
              {errors.map((message) => (
                <li className="flex items-start gap-1.5 text-destructive text-xs" key={message}>
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                  {message}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <button
            className="cursor-pointer rounded-md px-4 py-2 text-muted-foreground text-sm transition-colors hover:bg-accent"
            onClick={closeTypicalDerive}
            type="button"
          >
            Cancel
          </button>
          <ActionButton
            className={cn(
              'flex-none px-4',
              valid ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
            )}
            disabled={!valid}
            label="Derive"
            onClick={handleSubmit}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
