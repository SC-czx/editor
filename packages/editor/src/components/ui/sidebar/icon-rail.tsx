'use client'

import { Plus, Ruler } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './../../../components/ui/primitives/tooltip'
import { cn } from './../../../lib/utils'

export type PanelId = string

export type ExtraPanel = {
  id: string
  icon: ReactNode
  label: string
  component: ComponentType
  pluginId?: string
}

interface IconRailProps {
  activePanel: PanelId
  onPanelChange: (panel: PanelId) => void
  appMenuButton?: ReactNode
  extraPanels?: ExtraPanel[]
  className?: string
}

type RailPanel = { id: PanelId; label: string; iconSrc?: string; icon?: ReactNode }

const sitePanel: RailPanel = {
  id: 'site',
  iconSrc: '/icons/level.webp',
  label: 'Site',
}

// Vertical overview: every level's ordinal, height, base elevation and
// content counts in one table.
const verticalPanel: RailPanel = {
  id: 'vertical',
  icon: <Ruler className="h-5 w-5" />,
  label: 'Vertical overview',
}

const settingsPanel: RailPanel = {
  id: 'settings',
  iconSrc: '/icons/settings.webp',
  label: 'Settings',
}

const panels: RailPanel[] = [sitePanel, verticalPanel, settingsPanel]

function RailPanelButton({
  panel,
  isActive,
  onSelect,
}: {
  panel: RailPanel
  isActive: boolean
  onSelect: (id: PanelId) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg transition-all',
            isActive ? 'bg-accent' : 'hover:bg-accent',
          )}
          onClick={() => onSelect(panel.id)}
          type="button"
        >
          {panel.iconSrc ? (
            <img
              alt={panel.label}
              className={cn(
                'h-6 w-6 object-contain transition-all',
                !isActive && 'opacity-50 saturate-0',
              )}
              src={panel.iconSrc}
            />
          ) : (
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center transition-all',
                !isActive && 'opacity-50',
              )}
            >
              {panel.icon}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{panel.label}</TooltipContent>
    </Tooltip>
  )
}

export function IconRail({
  activePanel,
  onPanelChange,
  appMenuButton,
  extraPanels,
  className,
}: IconRailProps) {
  const regularExtraPanels = extraPanels?.filter((panel) => !panel.pluginId && panel.id !== 'plugins')
  const pluginPanels = extraPanels?.filter((panel) => panel.pluginId)
  const pluginsPanel = extraPanels?.find((panel) => panel.id === 'plugins')

  const renderExtraPanel = (panel: ExtraPanel) => {
    const isActive = activePanel === panel.id
    return (
      <Tooltip key={panel.id}>
        <TooltipTrigger asChild>
          <button
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg transition-all',
              isActive ? 'bg-accent' : 'hover:bg-accent',
            )}
            onClick={() => onPanelChange(panel.id)}
            type="button"
          >
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center transition-all',
                !isActive && 'opacity-50',
              )}
            >
              {panel.id === 'plugins' ? <Plus className="h-5 w-5" /> : panel.icon}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{panel.label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div
      className={cn(
        'flex h-full w-11 flex-col items-center gap-1 border-border/50 border-r py-2',
        className,
      )}
    >
      {/* App menu slot */}
      {appMenuButton}

      {/* Divider */}
      <div className="mb-1 h-px w-8 bg-border/50" />

      {/* Site panel */}
      {[sitePanel].map((panel) => (
        <RailPanelButton
          isActive={activePanel === panel.id}
          key={panel.id}
          onSelect={onPanelChange}
          panel={panel}
        />
      ))}

      {regularExtraPanels?.map(renderExtraPanel)}

      {/* Vertical overview + settings */}
      {[verticalPanel, settingsPanel].map((panel) => (
        <RailPanelButton
          isActive={activePanel === panel.id}
          key={panel.id}
          onSelect={onPanelChange}
          panel={panel}
        />
      ))}

      {(pluginPanels?.length || pluginsPanel) && (
        <div className="mt-1 flex w-9 flex-col items-center gap-1 border-border/70 border-t pt-2">
          {pluginPanels?.map(renderExtraPanel)}
          {pluginsPanel && renderExtraPanel(pluginsPanel)}
        </div>
      )}
    </div>
  )
}

export { panels }
