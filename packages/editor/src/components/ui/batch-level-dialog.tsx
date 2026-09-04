'use client'

import {
  type AnyNodeId,
  type BatchLevelHeights,
  type BatchLevelMode,
  type BuildingNode,
  DEFAULT_BATCH_LEVEL_HEIGHTS,
  type LevelNode,
  MAX_BATCH_LEVEL_COUNT,
  MAX_STOREY_HEIGHT,
  MIN_STOREY_HEIGHT,
  useScene,
  validateBatchLevelRequest,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { AlertTriangle, Layers } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { runBatchLevels } from '../../lib/level-batch-actions'
import { useLinearDisplay } from '../../lib/use-linear-display'
import { cn } from '../../lib/utils'
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

type HeightField = keyof BatchLevelHeights

const HEIGHT_FIELDS: Array<{ key: HeightField; label: string; hint: string }> = [
  { key: 'ground', label: 'Ground floor', hint: 'Lowest level of the block' },
  { key: 'standard', label: 'Typical floor', hint: 'Every level in between' },
  { key: 'top', label: 'Top floor', hint: 'Highest level of the block' },
  { key: 'basement', label: 'Basement', hint: 'Every level below ground' },
]

function clampCount(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), max)
}

function parseCount(raw: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw, 10)
  return clampCount(Number.isNaN(parsed) ? fallback : parsed, max)
}

export function BatchLevelDialog() {
  const request = useLevelBatch((state) => state.batchDialog)
  const closeBatchDialog = useLevelBatch((state) => state.closeBatchDialog)
  const setSelection = useViewer((state) => state.setSelection)

  const [aboveCount, setAboveCount] = useState('1')
  const [belowCount, setBelowCount] = useState('0')
  const [mode, setMode] = useState<BatchLevelMode>('append')
  const [heights, setHeights] = useState<BatchLevelHeights>({ ...DEFAULT_BATCH_LEVEL_HEIGHTS })
  const [errors, setErrors] = useState<string[]>([])
  const [rebuildAcknowledged, setRebuildAcknowledged] = useState(false)

  const { isImperial, toDisplay, toStored, displayUnit } = useLinearDisplay('m', 2)

  const buildingId = request?.buildingId ?? null
  const existingLevelCount = useScene(
    useShallow((state) => {
      if (!buildingId) return 0
      const building = state.nodes[buildingId]
      if (building?.type !== 'building') return 0
      return building.children.filter(
        (childId) => state.nodes[childId as AnyNodeId]?.type === 'level',
      ).length
    }),
  )
  const buildingName = useScene((state) => {
    if (!buildingId) return ''
    const building = state.nodes[buildingId]
    return building?.type === 'building' ? (building.name ?? '') : ''
  })

  // Reset once per opening, from the scene as it is at that moment: the count
  // snapshotted here decides whether "append" or "rebuild" is offered at all,
  // and re-running it on every scene change would fight the user's typing.
  useEffect(() => {
    if (!request) return
    let existing = 0
    const building = useScene.getState().nodes[request.buildingId]
    if (building?.type === 'building') {
      existing = building.children.filter(
        (childId) => useScene.getState().nodes[childId as AnyNodeId]?.type === 'level',
      ).length
    }
    setAboveCount('1')
    setBelowCount('0')
    setMode(existing === 0 ? 'append' : (request.initialMode ?? 'append'))
    setHeights({ ...DEFAULT_BATCH_LEVEL_HEIGHTS })
    setErrors([])
    setRebuildAcknowledged(false)
  }, [request])

  // Live validation against the real scene: the dialog refuses to submit an
  // impossible batch instead of failing halfway through the write.
  const liveErrors = useMemo(() => {
    if (!buildingId) return []
    return validateBatchLevelRequest(useScene.getState().nodes, {
      buildingId,
      aboveCount: Number.parseInt(aboveCount, 10) || 0,
      belowCount: Number.parseInt(belowCount, 10) || 0,
      heights,
      mode,
    })
  }, [buildingId, aboveCount, belowCount, heights, mode])

  if (!request || !buildingId) return null

  const maxPerBlock = MAX_BATCH_LEVEL_COUNT
  const totalLevels = clampCount(Number.parseInt(aboveCount, 10) || 0, maxPerBlock) +
    clampCount(Number.parseInt(belowCount, 10) || 0, maxPerBlock)
  const needsRebuildConfirm = mode === 'rebuild' && existingLevelCount > 0
  const canSubmit =
    liveErrors.length === 0 && totalLevels > 0 && (!needsRebuildConfirm || rebuildAcknowledged)

  const setHeight = (key: HeightField, raw: string) => {
    const parsed = Number.parseFloat(raw)
    if (Number.isNaN(parsed)) return
    const next: BatchLevelHeights = { ...heights }
    next[key] = toStored(parsed)
    setHeights(next)
  }

  const handleSubmit = () => {
    const result = runBatchLevels({
      buildingId,
      aboveCount: Number.parseInt(aboveCount, 10) || 0,
      belowCount: Number.parseInt(belowCount, 10) || 0,
      heights,
      mode,
    })
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    const topLevelId = result.createdLevelIds.at(-1)
    if (topLevelId) {
      setSelection({
        buildingId: buildingId as BuildingNode['id'],
        levelId: topLevelId as LevelNode['id'],
      })
    }
    closeBatchDialog()
  }

  const summary =
    totalLevels === 0
      ? 'Nothing to create yet.'
      : `${totalLevels} level${totalLevels === 1 ? '' : 's'} → ${mode === 'rebuild' ? 'replaces' : 'adds to'} ${existingLevelCount} existing.`

  return (
    <Dialog onOpenChange={(open) => !open && closeBatchDialog()} open>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Batch create levels
          </DialogTitle>
          <DialogDescription>
            {buildingName ? `Building “${buildingName}”` : 'Selected building'} · level 0 is the
            ground floor, basements are negative.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">Above ground</span>
              <input
                className="w-full rounded-lg border border-border/60 bg-accent/30 px-2.5 py-1.5 text-foreground text-sm outline-none focus:border-primary"
                max={maxPerBlock}
                min={0}
                onChange={(e) => setAboveCount(e.target.value)}
                onBlur={(e) =>
                  setAboveCount(String(parseCount(e.target.value, 0, maxPerBlock)))
                }
                step={1}
                type="number"
                value={aboveCount}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">Basements</span>
              <input
                className="w-full rounded-lg border border-border/60 bg-accent/30 px-2.5 py-1.5 text-foreground text-sm outline-none focus:border-primary"
                max={maxPerBlock}
                min={0}
                onChange={(e) => setBelowCount(e.target.value)}
                onBlur={(e) =>
                  setBelowCount(String(parseCount(e.target.value, 0, maxPerBlock)))
                }
                step={1}
                type="number"
                value={belowCount}
              />
            </label>
          </div>

          {existingLevelCount > 0 && (
            <div className="grid grid-cols-2 gap-1.5">
              {(['append', 'rebuild'] as BatchLevelMode[]).map((option) => (
                <button
                  className={cn(
                    'cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors',
                    mode === option
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-background hover:bg-accent/40',
                  )}
                  key={option}
                  onClick={() => {
                    setMode(option)
                    setRebuildAcknowledged(false)
                  }}
                  type="button"
                >
                  <div className="font-medium text-xs">
                    {option === 'append' ? 'Append on top' : 'Rebuild'}
                  </div>
                  <div className="mt-0.5 text-muted-foreground text-[11px]">
                    {option === 'append'
                      ? 'Stack new levels above the current top.'
                      : 'Replace every existing level.'}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {HEIGHT_FIELDS.map((field) => {
              const stored = heights[field.key]
              const outOfRange = stored < MIN_STOREY_HEIGHT || stored > MAX_STOREY_HEIGHT
              return (
                <label className="flex flex-col gap-1" key={field.key}>
                  <span className="text-muted-foreground text-xs">{field.label}</span>
                  <div className="relative">
                    <input
                      className={cn(
                        'w-full rounded-lg border bg-accent/30 py-1.5 pr-9 pl-2.5 text-foreground text-sm outline-none focus:border-primary',
                        outOfRange ? 'border-destructive' : 'border-border/60',
                      )}
                      onChange={(e) => setHeight(field.key, e.target.value)}
                      step={isImperial ? 0.25 : 0.1}
                      type="number"
                      value={Number(toDisplay(stored).toFixed(2))}
                    />
                    <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground text-xs">
                      {displayUnit}
                    </span>
                  </div>
                  <span className="text-muted-foreground/70 text-[10px]">{field.hint}</span>
                </label>
              )
            })}
          </div>

          {needsRebuildConfirm && (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5">
              <input
                checked={rebuildAcknowledged}
                className="mt-0.5"
                onChange={(e) => setRebuildAcknowledged(e.target.checked)}
                type="checkbox"
              />
              <span className="text-xs">
                <span className="flex items-center gap-1 font-medium text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  Delete {existingLevelCount} existing level
                  {existingLevelCount === 1 ? '' : 's'}
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  Every wall, floor and object on them is removed. This is a single undo step.
                </span>
              </span>
            </label>
          )}

          <p className="text-muted-foreground text-xs">
            Heights must be between {MIN_STOREY_HEIGHT} and {MAX_STOREY_HEIGHT} m. Maximum{' '}
            {MAX_BATCH_LEVEL_COUNT} levels per building.
          </p>
          <p className="text-foreground text-xs">{summary}</p>

          {(errors.length > 0 || liveErrors.length > 0) && (
            <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5">
              {(errors.length > 0 ? errors : liveErrors).map((message) => (
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
            onClick={closeBatchDialog}
            type="button"
          >
            Cancel
          </button>
          <ActionButton
            className={cn(
              'flex-none cursor-pointer px-4',
              !canSubmit && 'cursor-not-allowed opacity-50',
            )}
            disabled={!canSubmit}
            label="Create levels"
            onClick={handleSubmit}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
