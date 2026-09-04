'use client'

import {
  type AnyNodeId,
  type BuildingNode,
  type LevelNode,
  getLevelDisplayName,
  getStoreyOverviewRows,
  type StoreyOverviewRow,
  useScene,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { Layers, Table2 } from 'lucide-react'
import { memo, useMemo } from 'react'
import { useLinearDisplay } from './../../../../../lib/use-linear-display'
import { cn } from './../../../../../lib/utils'
import { useLevelBatch } from './../../../../../store/use-level-batch'
import { ActionButton } from './../../../controls/action-button'

/**
 * Vertical overview of every level in the active building: ordinal, name,
 * storey height, base elevation (cumulative — the same pure stack the
 * renderer reads) and content counts.
 *
 * Every value is derived from the scene store on render, so the table tracks
 * edits live without a refresh button.
 */
export function VerticalOverviewPanel() {
  const selectedBuildingId = useViewer((state) => state.selection.buildingId)
  const selectedLevelId = useViewer((state) => state.selection.levelId)
  const setSelection = useViewer((state) => state.setSelection)
  const openBatchDialog = useLevelBatch((state) => state.openBatchDialog)
  const selectedLevelIds = useLevelBatch((state) => state.selectedLevelIds)
  const toggleLevelSelected = useLevelBatch((state) => state.toggleLevelSelected)
  const { toDisplay, displayUnit } = useLinearDisplay('m', 2)

  // Falls back to the first building so the panel is useful even when the
  // viewer's selection points somewhere else (or nowhere).
  const resolvedBuildingId = useScene((state) => {
    if (selectedBuildingId && state.nodes[selectedBuildingId as AnyNodeId]?.type === 'building') {
      return selectedBuildingId as AnyNodeId
    }
    const first = Object.values(state.nodes).find((node) => node?.type === 'building') as
      | BuildingNode
      | undefined
    return first?.id ?? null
  })

  const buildingName = useScene((state) => {
    if (!resolvedBuildingId) return ''
    const building = state.nodes[resolvedBuildingId]
    return building?.type === 'building' ? (building.name ?? '') : ''
  })

  const nodes = useScene((state) => state.nodes)

  // Typical-floor links, recomputed from the same nodes snapshot that feeds
  // the rows so badges and counts can never disagree with the table.
  const typicalByLevelId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of Object.values(nodes)) {
      if (node?.type !== 'level') continue
      const masterId =
        typeof node.typicalMasterId === 'string' && node.typicalMasterId.length > 0
          ? node.typicalMasterId
          : null
      if (masterId) counts.set(masterId, (counts.get(masterId) ?? 0) + 1)
    }
    const badges: Record<string, string> = {}
    for (const node of Object.values(nodes)) {
      if (node?.type !== 'level') continue
      const id = node.id as string
      if (node.typicalMaster === true) {
        badges[id] = `master:${counts.get(id) ?? 0}`
        continue
      }
      const masterId =
        typeof node.typicalMasterId === 'string' && node.typicalMasterId.length > 0
          ? node.typicalMasterId
          : null
      const master = masterId ? nodes[masterId as AnyNodeId] : undefined
      badges[id] = masterId && master?.type === 'level' ? `instance:${masterId}` : ''
    }
    return badges
  }, [nodes])

  const rows = useMemo(
    () => getStoreyOverviewRows(nodes, resolvedBuildingId as AnyNodeId | null),
    [nodes, resolvedBuildingId],
  )

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          walls: acc.walls + row.wallCount,
          slabs: acc.slabs + row.slabCount,
          items: acc.items + row.itemCount,
          height: acc.height + row.height,
        }),
        { walls: 0, slabs: 0, items: 0, height: 0 },
      ),
    [rows],
  )

  if (!resolvedBuildingId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <Table2 className="h-5 w-5 text-muted-foreground/50" />
        <p className="text-muted-foreground text-sm">No building to overview yet.</p>
      </div>
    )
  }

  const fmt = (meters: number) => `${toDisplay(meters).toFixed(2)} ${displayUnit}`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-border/50 border-b px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm">
            {buildingName || 'Building'} · vertical overview
          </div>
          <div className="text-muted-foreground text-xs">
            {rows.length} level{rows.length === 1 ? '' : 's'} ·{' '}
            {fmt(totals.height)} total height
          </div>
        </div>
        <ActionButton
          className="flex-none cursor-pointer"
          icon={<Layers className="h-3.5 w-3.5" />}
          label="Batch"
          onClick={() => openBatchDialog(resolvedBuildingId as AnyNodeId)}
          title="Batch create levels"
        />
      </div>

      {rows.length === 0 ? (
        <div className="px-3 py-4 text-muted-foreground text-sm">
          This building has no levels yet.
        </div>
      ) : (
        <div className="subtle-scrollbar min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-sidebar">
              <tr className="text-muted-foreground text-[10px] uppercase tracking-wide">
                <th className="px-2 py-1.5 text-left font-medium">#</th>
                <th className="px-2 py-1.5 text-left font-medium">Name</th>
                <th className="px-2 py-1.5 text-right font-medium">Height</th>
                <th className="px-2 py-1.5 text-right font-medium">Base</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Walls">
                  W
                </th>
                <th className="px-2 py-1.5 text-right font-medium" title="Slabs">
                  S
                </th>
                <th className="px-2 py-1.5 text-right font-medium" title="Furniture items">
                  F
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <OverviewRow
                  fmt={fmt}
                  isSelected={row.id === selectedLevelId}
                  isTickSelected={selectedLevelIds.includes(row.id)}
                  key={row.id}
                  onSelect={(additive) => {
                    if (additive) {
                      toggleLevelSelected(row.id)
                      return
                    }
                    setSelection({
                      buildingId: resolvedBuildingId as BuildingNode['id'],
                      levelId: row.id as LevelNode['id'],
                    })
                  }}
                  row={row}
                  typical={typicalByLevelId[row.id] ?? ''}
                />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-border/50 border-t text-muted-foreground">
                <td className="px-2 py-1.5" />
                <td className="px-2 py-1.5">Total</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmt(totals.height)}</td>
                <td className="px-2 py-1.5" />
                <td className="px-2 py-1.5 text-right tabular-nums">{totals.walls}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{totals.slabs}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{totals.items}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

const OverviewRow = memo(function OverviewRow({
  row,
  typical,
  isSelected,
  isTickSelected,
  fmt,
  onSelect,
}: {
  row: StoreyOverviewRow
  typical: string
  isSelected: boolean
  isTickSelected: boolean
  fmt: (meters: number) => string
  onSelect: (additive: boolean) => void
}) {
  const isMaster = typical.startsWith('master:')
  const instanceCount = isMaster ? Number.parseInt(typical.slice('master:'.length), 10) || 0 : 0
  const isInstance = typical.startsWith('instance:')

  return (
    <tr
      className={cn(
        'cursor-pointer border-border/30 border-b transition-colors',
        isSelected ? 'bg-accent/50 text-foreground' : 'text-muted-foreground hover:bg-accent/30',
        isTickSelected && 'ring-1 ring-primary/50 ring-inset',
      )}
      onClick={(event) => onSelect(event.metaKey || event.ctrlKey)}
      title="⌘/Ctrl-click to add to the batch height selection"
    >
      <td className="px-2 py-1.5 text-left font-mono tabular-nums">{row.ordinal}</td>
      <td className="max-w-[9rem] px-2 py-1.5">
        <span className="flex items-center gap-1">
          <span className="truncate">
            {getLevelDisplayName({ name: row.name, level: row.ordinal })}
          </span>
          {isMaster && (
            <span
              className="shrink-0 rounded bg-primary/20 px-1 text-[9px] text-primary"
              title={`Typical floor master · ${instanceCount} instance${instanceCount === 1 ? '' : 's'}`}
            >
              M{instanceCount > 0 ? instanceCount : ''}
            </span>
          )}
          {isInstance && (
            <span
              className="shrink-0 rounded bg-sky-500/20 px-1 text-[9px] text-sky-300"
              title="Typical floor instance"
            >
              I
            </span>
          )}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.height)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.baseY)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{row.wallCount}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{row.slabCount}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{row.itemCount}</td>
    </tr>
  )
})
