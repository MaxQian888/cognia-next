"use client"

// Grouped nav for the Appearance section's master/detail layout, replacing the
// 11-trigger wrapping tab strip. Markup mirrors `ocr-sidebar.tsx`: an
// uppercase group header above `role="listitem"` buttons in a scrolling
// container. Deliberately not `role="tab"` — this is a list that drives a
// detail pane, not a tablist.

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { AppearanceNavGroup, AppearancePanelId } from "../nav-config"

export interface AppearanceNavProps {
  groups: readonly AppearanceNavGroup[]
  activeId: AppearancePanelId
  onSelect: (id: AppearancePanelId) => void
  /** Panels to omit — the plugins entry is hidden when nothing contributes. */
  hiddenIds?: readonly AppearancePanelId[]
}

export function AppearanceNav({ groups, activeId, onSelect, hiddenIds = [] }: AppearanceNavProps) {
  const t = useTranslations("settings.appearance.nav")
  const hidden = new Set(hiddenIds)
  return (
    <div
      className="flex-1 overflow-x-hidden overflow-y-auto p-1"
      role="list"
      aria-label={t("title")}
    >
      {groups.map((group) => {
        const items = group.items.filter((item) => !hidden.has(item.id))
        if (items.length === 0) return null
        return (
          <div key={group.id}>
            <div
              className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              data-testid={`appearance-nav-group-${group.id}`}
            >
              {t(`groups.${group.id}`)}
            </div>
            {items.map((item) => (
              <AppearanceNavItem
                key={item.id}
                id={item.id}
                icon={item.icon}
                label={t(`items.${item.id}.label`)}
                description={t(`items.${item.id}.description`)}
                isSelected={item.id === activeId}
                onSelect={onSelect}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function AppearanceNavItem({
  id,
  icon: Icon,
  label,
  description,
  isSelected,
  onSelect,
}: {
  id: AppearancePanelId
  icon: ComponentType<{ className?: string }>
  label: string
  description: string
  isSelected: boolean
  onSelect: (id: AppearancePanelId) => void
}) {
  return (
    <div role="listitem">
      <button
        type="button"
        aria-current={isSelected ? "true" : undefined}
        data-testid={`appearance-nav-item-${id}`}
        data-active={isSelected}
        onClick={() => onSelect(id)}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition",
          "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{description}</span>
        </span>
      </button>
    </div>
  )
}
