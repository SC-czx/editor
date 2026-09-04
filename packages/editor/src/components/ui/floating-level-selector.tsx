'use client'

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  type AnyNode,
  type AnyNodeId,
  type BuildingNode,
  DEFAULT_LEVEL_HEIGHT,
  emitter,
  getStoredLevelHeight,
  LevelNode,
  useScene,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Crosshair,
  GripVertical,
  Layers,
  MoreVertical,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { pasteSelectionAndPickUp } from '../editor/group-actions'
import {
  buildLevelDuplicateCreateOps,
  type LevelDuplicatePreset,
} from '../../lib/level-duplication'
import {
  getDefaultLevelName,
  getLevelDisplayName,
  MAX_STOREY_HEIGHT,
  MIN_STOREY_HEIGHT,
} from '@pascal-app/core'
import {
  runBatchLevelHeight,
  runLevelHeight,
  runSetTypicalMaster,
  runSyncTypicalInstances,
} from '../../lib/level-batch-actions'
import { deleteLevelWithFallbackSelection } from '../../lib/level-selection'
import { useLinearDisplay } from '../../lib/use-linear-display'
import { cn } from '../../lib/utils'
import { pruneSelectedLevels, useLevelBatch } from '../../store/use-level-batch'
import { ActionButton } from './controls/action-button'
import { SliderControl } from './controls/slider-control'
import { LevelDuplicateDialog } from './level-duplicate-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './primitives/dialog'
import { Popover, PopoverContent, PopoverTrigger } from './primitives/popover'

// ── Typical-floor metadata ──────────────────────────────────────────────────

type TypicalMeta = {
  isMaster: boolean
  masterId: string | null
  masterOrdinal: number | null
  instanceCount: number
}

const EMPTY_TYPICAL_META: TypicalMeta = {
  isMaster: false,
  masterId: null,
  masterOrdinal: null,
  instanceCount: 0,
}

/**
 * Compact encoding so the `useShallow` selector compares primitives instead of
 * freshly-built objects — otherwise this would re-render on every scene edit.
 * Format: `master:<count>` | `instance:<masterId>:<masterOrdinal>` | ''.
 */
function decodeTypicalMeta(encoded: string | undefined): TypicalMeta {
  if (!encoded) return EMPTY_TYPICAL_META
  if (encoded.startsWith('master:')) {
    return {
      ...EMPTY_TYPICAL_META,
      isMaster: true,
      instanceCount: Number.parseInt(encoded.slice('master:'.length), 10) || 0,
    }
  }
  if (encoded.startsWith('instance:')) {
    const [, masterId, ordinal] = encoded.split(':')
    const parsed = Number.parseInt(ordinal ?? '', 10)
    return {
      ...EMPTY_TYPICAL_META,
      masterId: masterId || null,
      masterOrdinal: Number.isNaN(parsed) ? null : parsed,
    }
  }
  return EMPTY_TYPICAL_META
}

// ── Level groups ────────────────────────────────────────────────────────────

type LevelGroup = { key: string; label: string; levels: LevelNode[] }

/**
 * Splits the building's levels into the four vertical bands, preserving the
 * top-first display order. Bands are contiguous by ordinal, so the existing
 * drag-to-reorder logic (which reads the flat visual order) keeps working
 * unchanged.
 *
 * With a single level there is no top floor to break out — that level *is* the
 * ground floor.
 */
export function buildLevelGroups(levelsDescending: LevelNode[]): LevelGroup[] {
  if (levelsDescending.length === 0) return []

  const topId = levelsDescending.length > 1 ? levelsDescending[0]?.id : undefined
  const buckets = new Map<string, LevelNode[]>()
  const push = (key: string, level: LevelNode) => {
    const bucket = buckets.get(key)
    if (bucket) bucket.push(level)
    else buckets.set(key, [level])
  }

  for (const level of levelsDescending) {
    if (level.id === topId) push('top', level)
    else if (level.level < 0) push('basement', level)
    else if (level.level === 0) push('ground', level)
    else push('standard', level)
  }

  const order: Array<{ key: string; label: string }> = [
    { key: 'top', label: 'Top floor' },
    { key: 'standard', label: 'Standard floors' },
    { key: 'ground', label: 'Ground floor' },
    { key: 'basement', label: 'Basement' },
  ]

  return order
    .filter((entry) => buckets.has(entry.key))
    .map((entry) => ({ ...entry, levels: buckets.get(entry.key) ?? [] }))
}

// ── Inline rename input for a level row ─────────────────────────────────────

function LevelInlineRename({
  level,
  isEditing,
  onStopEditing,
}: {
  level: LevelNode
  isEditing: boolean
  onStopEditing: () => void
}) {
  const updateNode = useScene((s) => s.updateNode)
  const defaultName = getDefaultLevelName(level.level)
  const [value, setValue] = useState(level.name || '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      setValue(level.name || '')
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    }
  }, [isEditing, level.name])

  const handleSave = useCallback(() => {
    const trimmed = value.trim()
    if (trimmed !== level.name) {
      updateNode(level.id, { name: trimmed || undefined })
    }
    onStopEditing()
  }, [value, level.id, level.name, updateNode, onStopEditing])

  if (!isEditing) return null

  return (
    <input
      className="m-0 h-full w-full min-w-0 rounded-lg bg-transparent px-2.5 py-1.5 font-medium text-foreground text-xs outline-none ring-1 ring-primary/50"
      onBlur={handleSave}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          handleSave()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onStopEditing()
        }
      }}
      placeholder={defaultName}
      ref={inputRef}
      type="text"
      value={value}
    />
  )
}

// ── Typical-floor badges ────────────────────────────────────────────────────

function TypicalMasterBadge({ instanceCount }: { instanceCount: number }) {
  return (
    <span
      className="mr-0.5 flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-primary/20 px-1 py-0.5 font-medium text-[9px] text-primary"
      title={`Typical floor master · ${instanceCount} instance${instanceCount === 1 ? '' : 's'}`}
    >
      <Layers className="h-2.5 w-2.5" />M
      {instanceCount > 0 && <span className="tabular-nums">{instanceCount}</span>}
    </span>
  )
}

function TypicalInstanceBadge({
  masterOrdinal,
  onGoToMaster,
}: {
  masterOrdinal: number | null
  onGoToMaster: () => void
}) {
  const label = masterOrdinal === null ? '↗' : `↗${masterOrdinal}`
  return (
    <button
      className="mr-0.5 flex shrink-0 items-center whitespace-nowrap rounded bg-sky-500/20 px-1 py-0.5 font-medium text-[9px] text-sky-300 transition-colors hover:bg-sky-500/35 hover:text-sky-200"
      onClick={(e) => {
        e.stopPropagation()
        onGoToMaster()
      }}
      title="Go to the typical floor master"
      type="button"
    >
      {label}
    </button>
  )
}

// ── Level row with three-dot menu ───────────────────────────────────────────

function LevelRow({
  level,
  isSelected,
  isDragging,
  isMultiSelected,
  typical,
  onSelect,
  onDuplicate,
  onPaste,
  onRequestDelete,
  onToggleMultiSelect,
  dragHandleProps,
  dragHandleRef,
}: {
  level: LevelNode
  isSelected: boolean
  isDragging?: boolean
  isMultiSelected: boolean
  typical: TypicalMeta
  onSelect: (additive: boolean) => void
  onDuplicate: (preset?: LevelDuplicatePreset) => void
  onPaste?: () => void
  onRequestDelete: () => void
  onToggleMultiSelect: () => void
  dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>
  dragHandleRef?: (element: HTMLButtonElement | null) => void
}) {
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const setSelection = useViewer((s) => s.setSelection)
  const { isImperial, toDisplay, displayUnit } = useLinearDisplay('m', 2)

  const storeyHeight = getStoredLevelHeight(level)
  // toFixed(2) + strip one trailing zero: "2.50" → "2.5", "2.75" stays.
  const storeyHeightLabel = `${toDisplay(storeyHeight).toFixed(2).replace(/0$/, '')} ${displayUnit}`
  // Same rule as the site panel and command palette: the ordinal-0 ground
  // floor is the vertical model's zero anchor and must never be deletable.
  const canDeleteLevel = level.level !== 0

  // Clean preset values per display system; imperial stores exact meters
  // for whole-foot storey heights.
  const heightPresets = isImperial
    ? [
        { label: '8 ft', height: 2.4384 },
        { label: '9 ft', height: 2.7432 },
        { label: '10 ft', height: 3.048 },
      ]
    : [
        { label: '2.5 m', height: 2.5 },
        { label: '3.0 m', height: 3.0 },
        { label: '3.5 m', height: 3.5 },
      ]

  const goToMaster = () => {
    if (!typical.masterId) return
    setSelection({ levelId: typical.masterId as LevelNode['id'] })
    emitter.emit('camera-controls:focus', { nodeId: typical.masterId as AnyNodeId })
  }

  return (
    <div className="group/level">
      {isEditing ? (
        <LevelInlineRename
          isEditing={isEditing}
          level={level}
          onStopEditing={() => setIsEditing(false)}
        />
      ) : (
        <div
          className={cn(
            'flex items-center rounded-lg transition-colors',
            isDragging && 'bg-white/10 text-foreground shadow-lg',
            isMultiSelected && 'ring-1 ring-primary/60',
            isSelected
              ? 'bg-white/10 text-foreground'
              : 'text-muted-foreground/70 hover:bg-white/5 hover:text-muted-foreground',
          )}
        >
          <button
            {...dragHandleProps}
            aria-label={`Reorder ${getLevelDisplayName(level)}`}
            className={cn(
              'ml-0.5 flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/35 opacity-0 transition-colors hover:bg-white/5 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 group-hover/level:opacity-100',
              isDragging && 'cursor-grabbing opacity-100',
            )}
            onClick={(e) => {
              e.stopPropagation()
              dragHandleProps?.onClick?.(e)
            }}
            ref={dragHandleRef}
            title="Drag to reorder"
            type="button"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>

          <button
            className="flex min-w-0 flex-1 items-center justify-start py-1.5 pr-2 pl-1 font-medium text-xs"
            onClick={(e) => onSelect(e.metaKey || e.ctrlKey)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setIsEditing(true)
            }}
            title={`${getLevelDisplayName(level)} — ⌘/Ctrl-click to add to the height batch`}
            type="button"
          >
            <span className="truncate">{getLevelDisplayName(level)}</span>
            {typical.isMaster && <TypicalMasterBadge instanceCount={typical.instanceCount} />}
            {typical.masterId && (
              <TypicalInstanceBadge masterOrdinal={typical.masterOrdinal} onGoToMaster={goToMaster} />
            )}
          </button>

          {/* Storey height badge — opens the height popover */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="mr-0.5 shrink-0 whitespace-nowrap rounded px-1 py-0.5 font-mono text-[10px] text-muted-foreground/50 tabular-nums transition-colors hover:bg-white/5 hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
                title="Level height"
                type="button"
              >
                {storeyHeightLabel}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-56 p-2"
              onClick={(e) => e.stopPropagation()}
              side="right"
              sideOffset={8}
            >
              <SliderControl
                label="Level height"
                max={20}
                min={1}
                onChange={(v) => runLevelHeight(level.id as AnyNodeId, v)}
                precision={3}
                step={0.1}
                unit="m"
                value={Math.round(storeyHeight * 1000) / 1000}
              />
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {heightPresets.map((preset) => (
                  <ActionButton
                    className="h-7 px-2"
                    key={preset.label}
                    label={preset.label}
                    onClick={() => runLevelHeight(level.id as AnyNodeId, preset.height)}
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>

          {/* Vertical three-dot menu — inside the pill */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground/40 opacity-0 transition-all hover:text-foreground group-hover/level:opacity-100"
                onClick={(e) => e.stopPropagation()}
                type="button"
              >
                <MoreVertical className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-52 p-1" side="right" sideOffset={8}>
              <MenuItem
                icon={<Copy className="h-3 w-3" />}
                onClick={() => onDuplicate()}
                title="Duplicate level"
              >
                Duplicate level
              </MenuItem>
              <MenuItem
                icon={<Copy className="h-3 w-3" />}
                onClick={() => setDuplicateDialogOpen(true)}
                title="Duplicate level with options"
              >
                Duplicate with options...
              </MenuItem>
              {onPaste && (
                <MenuItem
                  icon={<ClipboardPaste className="h-3 w-3" />}
                  onClick={onPaste}
                  title="Paste copied selection"
                >
                  Paste copied selection
                </MenuItem>
              )}

              <div className="my-1 h-px bg-border/60" />

              {typical.isMaster ? (
                <MenuItem
                  icon={<Layers className="h-3 w-3" />}
                  onClick={() => runSetTypicalMaster(level.id as AnyNodeId, false)}
                  title="Unmark this typical floor master"
                >
                  Unmark typical master
                </MenuItem>
              ) : (
                <MenuItem
                  icon={<Layers className="h-3 w-3" />}
                  onClick={() => runSetTypicalMaster(level.id as AnyNodeId, true)}
                  title="Mark this level as a typical floor master"
                >
                  Mark as typical master
                </MenuItem>
              )}
              {typical.isMaster && (
                <>
                  <MenuItem
                    icon={<CopyPlus className="h-3 w-3" />}
                    onClick={() =>
                      useLevelBatch.getState().openTypicalDerive(level.id as AnyNodeId)
                    }
                    title="Derive typical floor instances from this master"
                  >
                    Derive typical floors...
                  </MenuItem>
                  <MenuItem
                    icon={<RefreshCw className="h-3 w-3" />}
                    onClick={() => runSyncTypicalInstances(level.id as AnyNodeId)}
                    title="Push this master's structure onto every instance"
                  >
                    Sync {typical.instanceCount} instance
                    {typical.instanceCount === 1 ? '' : 's'}
                  </MenuItem>
                </>
              )}
              {typical.masterId && (
                <MenuItem
                  icon={<Crosshair className="h-3 w-3" />}
                  onClick={goToMaster}
                  title="Select and focus the typical floor master"
                >
                  Go to master floor
                </MenuItem>
              )}

              <div className="my-1 h-px bg-border/60" />

              <MenuItem
                icon={<Plus className="h-3 w-3" />}
                onClick={onToggleMultiSelect}
                title="Add this level to the batch height selection"
              >
                {isMultiSelected ? 'Remove from height batch' : 'Add to height batch'}
              </MenuItem>
              <MenuItem
                className="enabled:hover:bg-white/10 enabled:hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canDeleteLevel}
                icon={<Trash2 className="h-3 w-3" />}
                onClick={onRequestDelete}
                title={canDeleteLevel ? 'Delete level' : 'The ground level cannot be deleted'}
              >
                Delete level
              </MenuItem>
            </PopoverContent>
          </Popover>
        </div>
      )}
      <LevelDuplicateDialog
        level={level}
        onConfirm={(preset) => {
          onDuplicate(preset)
          setDuplicateDialogOpen(false)
        }}
        onOpenChange={setDuplicateDialogOpen}
        open={duplicateDialogOpen}
      />
    </div>
  )
}

function MenuItem({
  children,
  icon,
  className,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  className?: string
  disabled?: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted-foreground text-xs transition-colors hover:bg-white/10 hover:text-foreground',
        className,
      )}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      type="button"
    >
      {icon}
      {children}
    </button>
  )
}

function SortableLevelRow({
  level,
  isSelected,
  isMultiSelected,
  typical,
  onSelect,
  onDuplicate,
  onPaste,
  onRequestDelete,
  onToggleMultiSelect,
}: {
  level: LevelNode
  isSelected: boolean
  isMultiSelected: boolean
  typical: TypicalMeta
  onSelect: (additive: boolean) => void
  onDuplicate: (preset?: LevelDuplicatePreset) => void
  onPaste?: () => void
  onRequestDelete: () => void
  onToggleMultiSelect: () => void
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: level.id })

  const style: CSSProperties = {
    opacity: isDragging ? 0.86 : undefined,
    position: 'relative',
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined,
  }

  return (
    <div ref={setNodeRef} style={style}>
      <LevelRow
        dragHandleProps={{ ...attributes, ...listeners }}
        dragHandleRef={setActivatorNodeRef}
        isDragging={isDragging}
        isMultiSelected={isMultiSelected}
        isSelected={isSelected}
        level={level}
        onDuplicate={onDuplicate}
        onPaste={onPaste}
        onRequestDelete={onRequestDelete}
        onSelect={onSelect}
        onToggleMultiSelect={onToggleMultiSelect}
        typical={typical}
      />
    </div>
  )
}

// ── Batch height bar ────────────────────────────────────────────────────────

function BatchHeightBar({ levelIds }: { levelIds: AnyNodeId[] }) {
  const clearSelectedLevels = useLevelBatch((state) => state.clearSelectedLevels)
  const { isImperial, toDisplay, toStored, displayUnit } = useLinearDisplay('m', 2)
  const [raw, setRaw] = useState('2.8')
  const [error, setError] = useState<string | null>(null)

  const stored = toStored(Number.parseFloat(raw) || 0)
  const outOfRange = stored < MIN_STOREY_HEIGHT || stored > MAX_STOREY_HEIGHT

  return (
    <div className="mt-1 flex flex-col gap-1 rounded-xl border border-primary/30 bg-background/90 p-1.5 shadow-2xl backdrop-blur-md">
      <div className="px-0.5 text-muted-foreground text-[10px]">
        {levelIds.length} level{levelIds.length === 1 ? '' : 's'} selected
      </div>
      <div className="flex items-center gap-1">
        <input
          className={cn(
            'min-w-0 flex-1 rounded-lg border bg-accent/30 px-1.5 py-1 text-foreground text-xs outline-none focus:border-primary',
            outOfRange ? 'border-destructive' : 'border-border/60',
          )}
          onChange={(e) => {
            setRaw(e.target.value)
            setError(null)
          }}
          step={isImperial ? 0.25 : 0.1}
          type="number"
          value={raw}
        />
        <span className="shrink-0 text-muted-foreground text-[10px]">{displayUnit}</span>
        <button
          className={cn(
            'shrink-0 rounded-lg bg-primary px-2 py-1 text-primary-foreground text-[11px] transition-opacity hover:opacity-90',
            outOfRange && 'cursor-not-allowed opacity-50',
          )}
          disabled={outOfRange}
          onClick={() => {
            const result = runBatchLevelHeight(levelIds, stored, { enforceHeightRange: true })
            setError(result.ok ? null : (result.errors[0] ?? 'Could not apply the height.'))
          }}
          type="button"
        >
          Apply
        </button>
        <button
          className="shrink-0 rounded-lg px-1.5 py-1 text-muted-foreground text-[11px] transition-colors hover:bg-white/5 hover:text-foreground"
          onClick={clearSelectedLevels}
          title="Clear selection"
          type="button"
        >
          Clear
        </button>
      </div>
      {error && <div className="px-0.5 text-destructive text-[10px]">{error}</div>}
      <div className="px-0.5 text-muted-foreground/70 text-[10px]">
        Levels above shift automatically; walls, ceilings and stairs follow the plane.
      </div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export function FloatingLevelSelector() {
  const selectedBuildingId = useViewer((s) => s.selection.buildingId)
  const levelId = useViewer((s) => s.selection.levelId)
  const setSelection = useViewer((s) => s.setSelection)
  const createNode = useScene((s) => s.createNode)
  const createNodes = useScene((s) => s.createNodes)
  const updateNodes = useScene((s) => s.updateNodes)
  const openBatchDialog = useLevelBatch((state) => state.openBatchDialog)
  const selectedLevelIds = useLevelBatch((state) => state.selectedLevelIds)
  const toggleLevelSelected = useLevelBatch((state) => state.toggleLevelSelected)

  const [deletingLevel, setDeletingLevel] = useState<LevelNode | null>(null)
  const [draggingLevelId, setDraggingLevelId] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const resolvedBuildingId = useScene((state) => {
    if (selectedBuildingId) return selectedBuildingId
    const first = Object.values(state.nodes).find((n) => n?.type === 'building') as
      | BuildingNode
      | undefined
    return first?.id ?? null
  })

  const levels = useScene(
    useShallow((state) => {
      if (!resolvedBuildingId) return [] as LevelNode[]
      const building = state.nodes[resolvedBuildingId]
      if (!building || building.type !== 'building') return [] as LevelNode[]
      return (building as BuildingNode).children
        .map((id) => state.nodes[id])
        .filter((node): node is LevelNode => node?.type === 'level')
        .sort((a, b) => a.level - b.level)
    }),
  )

  // A ticked level that was deleted (or undone away) must not survive into a
  // later batch height edit.
  useEffect(() => {
    pruneSelectedLevels(levels)
  }, [levels])

  // Typical-floor links, encoded as strings so `useShallow` compares
  // primitives instead of a freshly-built object per render.
  const typicalByLevelId = useScene(
    useShallow((state) => {
      const counts = new Map<string, number>()
      const encoded: Record<string, string> = {}
      const levelNodes: LevelNode[] = []
      for (const node of Object.values(state.nodes)) {
        if (node?.type !== 'level') continue
        levelNodes.push(node)
        const masterId =
          typeof node.typicalMasterId === 'string' && node.typicalMasterId.length > 0
            ? node.typicalMasterId
            : null
        if (masterId) counts.set(masterId, (counts.get(masterId) ?? 0) + 1)
      }
      for (const node of levelNodes) {
        const id = node.id as string
        if (node.typicalMaster === true) {
          encoded[id] = `master:${counts.get(id) ?? 0}`
          continue
        }
        const masterId =
          typeof node.typicalMasterId === 'string' && node.typicalMasterId.length > 0
            ? node.typicalMasterId
            : null
        const master = masterId ? state.nodes[masterId as AnyNodeId] : undefined
        encoded[id] =
          masterId && master?.type === 'level' ? `instance:${masterId}:${master.level}` : ''
      }
      return encoded
    }),
  )

  const handleAddAbove = useCallback(() => {
    if (!resolvedBuildingId) return
    const maxLevel = levels.length > 0 ? Math.max(...levels.map((l) => l.level)) : -1
    const newLevel = LevelNode.parse({
      level: maxLevel + 1,
      height: DEFAULT_LEVEL_HEIGHT,
      children: [],
      parentId: resolvedBuildingId,
    })
    createNode(newLevel, resolvedBuildingId)
    setSelection({ buildingId: resolvedBuildingId, levelId: newLevel.id })
  }, [resolvedBuildingId, levels, createNode, setSelection])

  const handleAddBelow = useCallback(() => {
    if (!resolvedBuildingId) return
    const minLevel = levels.length > 0 ? Math.min(...levels.map((l) => l.level)) : 1
    const newLevel = LevelNode.parse({
      level: minLevel - 1,
      height: DEFAULT_LEVEL_HEIGHT,
      children: [],
      parentId: resolvedBuildingId,
    })
    createNode(newLevel, resolvedBuildingId)
    setSelection({ buildingId: resolvedBuildingId, levelId: newLevel.id })
  }, [resolvedBuildingId, levels, createNode, setSelection])

  const handleInsertBetween = useCallback(
    (lowerIndex: number) => {
      if (!resolvedBuildingId) return
      const lower = levels[lowerIndex]
      if (!lower) return

      const newLevelNumber = lower.level + 1
      const toShift = levels.filter((l) => l.level >= newLevelNumber)
      if (toShift.length > 0) {
        updateNodes(
          toShift.map((l) => ({
            id: l.id as AnyNodeId,
            data: { level: l.level + 1 } as Partial<AnyNode>,
          })),
        )
      }

      const newLevel = LevelNode.parse({
        level: newLevelNumber,
        height: DEFAULT_LEVEL_HEIGHT,
        children: [],
        parentId: resolvedBuildingId,
      })
      createNode(newLevel, resolvedBuildingId)
      setSelection({ buildingId: resolvedBuildingId, levelId: newLevel.id })
    },
    [resolvedBuildingId, levels, createNode, updateNodes, setSelection],
  )

  const handleConfirmDelete = useCallback(() => {
    if (!deletingLevel) return
    deleteLevelWithFallbackSelection(deletingLevel.id)
    setDeletingLevel(null)
  }, [deletingLevel])

  const handleDuplicateLevel = useCallback(
    (level: LevelNode, preset: LevelDuplicatePreset = 'everything') => {
      const { createOps, newLevelId, shiftedLevels } = buildLevelDuplicateCreateOps({
        nodes: useScene.getState().nodes,
        level,
        levels,
        preset,
      })

      if (shiftedLevels.length > 0) {
        updateNodes(
          shiftedLevels.map((shiftedLevel) => ({
            id: shiftedLevel.id as AnyNodeId,
            data: { level: shiftedLevel.level } as Partial<AnyNode>,
          })),
        )
      }
      createNodes(createOps)

      setSelection({
        buildingId: resolvedBuildingId ?? undefined,
        levelId: newLevelId as LevelNode['id'],
      })
    },
    [createNodes, levels, resolvedBuildingId, setSelection, updateNodes],
  )

  const handlePasteToLevel = useCallback((level: LevelNode) => {
    void pasteSelectionAndPickUp(level.id)
  }, [])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingLevelId(String(event.active.id))
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingLevelId(null)

      const { active, over } = event
      if (!over || active.id === over.id) return

      const visualLevels = [...levels].reverse()
      const oldIndex = visualLevels.findIndex((level) => level.id === active.id)
      const newIndex = visualLevels.findIndex((level) => level.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return

      const reorderedVisualLevels = arrayMove(visualLevels, oldIndex, newIndex)
      const levelNumbersDescending = levels.map((level) => level.level).sort((a, b) => b - a)

      const updates = reorderedVisualLevels
        .map((level, index) => ({
          id: level.id as AnyNodeId,
          nextLevel: levelNumbersDescending[index],
          data: { level: levelNumbersDescending[index] } as Partial<AnyNode>,
        }))
        .filter(({ id, nextLevel }) => {
          const currentLevel = levels.find((level) => level.id === id)
          return currentLevel?.level !== nextLevel
        })
        .map(({ id, data }) => ({ id, data }))

      if (updates.length > 0) {
        updateNodes(updates)
      }
    },
    [levels, updateNodes],
  )

  const handleDragCancel = useCallback(() => {
    setDraggingLevelId(null)
  }, [])

  const reversedLevels = useMemo(() => [...levels].reverse(), [levels])
  const groups = useMemo(() => buildLevelGroups(reversedLevels), [reversedLevels])
  const sortableLevelIds = reversedLevels.map((level) => level.id)

  if (levels.length === 0) return null

  const addButtonClass =
    'absolute left-1/2 z-10 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full border border-border/80 bg-neutral-800 text-muted-foreground/60 shadow-md transition-colors hover:bg-neutral-700 hover:text-foreground'

  return (
    <>
      <div className="pointer-events-auto absolute top-14 left-3 z-20">
        <div className="relative">
          {/* Floating + at top edge */}
          {!draggingLevelId && (
            <button
              className={cn(addButtonClass, 'top-0 -translate-y-1/2')}
              // A stable hook for host-app onboarding to point at. Static, and
              // read only from outside: nothing here depends on it.
              data-guide-target="level-add"
              onClick={handleAddAbove}
              title="Add level above"
              type="button"
            >
              <Plus className="h-2.5 w-2.5" />
            </button>
          )}

          {/* Floating + at bottom edge */}
          {!draggingLevelId && (
            <button
              className={cn(addButtonClass, 'bottom-0 translate-y-1/2')}
              onClick={handleAddBelow}
              title="Add level below"
              type="button"
            >
              <Plus className="h-2.5 w-2.5" />
            </button>
          )}

          {/* Level list */}
          <DndContext
            collisionDetection={closestCenter}
            onDragCancel={handleDragCancel}
            onDragEnd={handleDragEnd}
            onDragStart={handleDragStart}
            sensors={sensors}
          >
            <SortableContext items={sortableLevelIds} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-background/90 p-1 shadow-2xl backdrop-blur-md">
                {groups.map((group) => (
                  <div className="flex flex-col gap-0.5" key={group.key}>
                    <div className="flex items-center gap-1 px-1.5 pt-0.5 text-muted-foreground/50 text-[9px] uppercase tracking-wide">
                      <span className="truncate">{group.label}</span>
                      <span className="h-px flex-1 bg-border/60" />
                    </div>
                    {group.levels.map((level) => {
                      const isSelected = level.id === levelId
                      const sortedIndex = levels.indexOf(level)
                      const showGapBelow = level.id !== reversedLevels.at(-1)?.id

                      return (
                        <div
                          className="relative"
                          // A stable hook for host-app onboarding to point at, on
                          // the ground floor only — the one level a guide can name
                          // without knowing the building. Static, and read only
                          // from outside: nothing here depends on it.
                          data-guide-target={level.level === 0 ? 'level-ground' : undefined}
                          key={level.id}
                        >
                          <SortableLevelRow
                            isMultiSelected={selectedLevelIds.includes(level.id as AnyNodeId)}
                            isSelected={isSelected}
                            level={level}
                            onDuplicate={(preset) => handleDuplicateLevel(level, preset)}
                            onPaste={() => handlePasteToLevel(level)}
                            onRequestDelete={() => setDeletingLevel(level)}
                            onSelect={(additive) => {
                              if (additive) {
                                toggleLevelSelected(level.id as AnyNodeId)
                                return
                              }
                              setSelection(
                                resolvedBuildingId
                                  ? { buildingId: resolvedBuildingId, levelId: level.id }
                                  : { levelId: level.id },
                              )
                            }}
                            onToggleMultiSelect={() => toggleLevelSelected(level.id as AnyNodeId)}
                            typical={decodeTypicalMeta(typicalByLevelId[level.id])}
                          />

                          {showGapBelow && !draggingLevelId && (
                            <button
                              className={cn(addButtonClass, 'bottom-0 translate-y-1/2')}
                              onClick={() => handleInsertBetween(sortedIndex - 1)}
                              title="Insert level here"
                              type="button"
                            >
                              <Plus className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}

                {/* Batch entry points */}
                {!draggingLevelId && (
                  <div className="mt-0.5 flex gap-1 border-border/60 border-t pt-1">
                    <button
                      className="flex flex-1 items-center justify-center gap-1 rounded-lg px-1.5 py-1 text-muted-foreground text-[10px] transition-colors hover:bg-white/5 hover:text-foreground"
                      onClick={() => resolvedBuildingId && openBatchDialog(resolvedBuildingId)}
                      title="Create many levels at once"
                      type="button"
                    >
                      <Layers className="h-3 w-3" />
                      Batch create
                    </button>
                  </div>
                )}
              </div>
            </SortableContext>
          </DndContext>

          {selectedLevelIds.length > 0 && !draggingLevelId && (
            <BatchHeightBar levelIds={selectedLevelIds} />
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog onOpenChange={(open) => !open && setDeletingLevel(null)} open={!!deletingLevel}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete level</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <strong>{deletingLevel ? getLevelDisplayName(deletingLevel) : ''}</strong>? All
              walls, floors, and objects on this level will be permanently removed.
              {deletingLevel?.typicalMaster === true && (
                <>
                  {' '}
                  It is a typical-floor master — its instances become ordinary levels and keep
                  their content.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              className="rounded-full border border-border px-4 py-2 text-sm transition-colors hover:bg-accent"
              onClick={() => setDeletingLevel(null)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="rounded-full bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700"
              onClick={handleConfirmDelete}
              type="button"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
