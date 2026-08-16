"use client"

// Grouped nav for the Appearance section's master/detail layout, replacing the
// 11-trigger wrapping tab strip. Markup mirrors `ocr-sidebar.tsx`: an
// uppercase group header above `role="listitem"` buttons in a scrolling
// container. Deliberately not `role="tab"` — this is a list that drives a
// detail pane, not a tablist.
//
// Focus is roving: twelve entries would otherwise be twelve tab stops between
// the section header and the panel you came here to edit. One entry holds the
// tab stop and the arrow keys move between them, the same shape the wallpaper
// scope group uses. Activation stays manual (Enter / Space / click) rather than
// following focus — every selection swaps the whole detail panel and rewrites
// the URL, which is too much to fire on an arrow key.

import { useRef, useState, type ComponentType, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AppearanceNavGroup, AppearancePanelId } from "../nav-config"

export interface AppearanceNavProps {
  groups: readonly AppearanceNavGroup[]
  activeId: AppearancePanelId
  onSelect: (id: AppearancePanelId) => void
  /** Panels to omit — the plugins entry is hidden when nothing contributes. */
  hiddenIds?: readonly AppearancePanelId[]
}

/** Arrow keys that move focus within the nav, and by how many entries. */
const ROVING_KEYS: Record<string, number> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
}

export function AppearanceNav({ groups, activeId, onSelect, hiddenIds = [] }: AppearanceNavProps) {
  const t = useTranslations("settings.appearance.nav")
  const hidden = new Set(hiddenIds)
  const itemRefs = useRef<Partial<Record<AppearancePanelId, HTMLButtonElement | null>>>({})

  // Which entry currently owns the single tab stop. Null means "the active
  // one", which is where focus should land when you tab in cold.
  const [focusedId, setFocusedId] = useState<AppearancePanelId | null>(null)
  // Selection moving (a click here, a deep link, the mobile sheet) hands the
  // tab stop back to the active entry. Derived during render — the React 19
  // way to sync state to a changed prop without an effect.
  const [activeSeed, setActiveSeed] = useState(activeId)
  if (activeSeed !== activeId) {
    setActiveSeed(activeId)
    setFocusedId(null)
  }
  const rovingId = focusedId ?? activeId

  // Flattened visible order — arrow keys cross group boundaries, because the
  // groups are a visual grouping and not separate widgets.
  const order = groups.flatMap((group) =>
    group.items.filter((item) => !hidden.has(item.id)).map((item) => item.id)
  )

  const handleKeyDown = (event: KeyboardEvent, id: AppearancePanelId) => {
    const index = order.indexOf(id)
    if (index < 0) return
    const delta = ROVING_KEYS[event.key]
    let nextIndex: number | null = null
    if (delta !== undefined) nextIndex = (index + delta + order.length) % order.length
    else if (event.key === "Home") nextIndex = 0
    else if (event.key === "End") nextIndex = order.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextId = order[nextIndex]
    if (!nextId) return
    setFocusedId(nextId)
    itemRefs.current[nextId]?.focus()
  }

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
                isRoving={item.id === rovingId}
                onSelect={onSelect}
                onKeyDown={handleKeyDown}
                registerRef={(node) => {
                  itemRefs.current[item.id] = node
                }}
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
  isRoving,
  onSelect,
  onKeyDown,
  registerRef,
}: {
  id: AppearancePanelId
  icon: ComponentType<{ className?: string }>
  label: string
  description: string
  isSelected: boolean
  isRoving: boolean
  onSelect: (id: AppearancePanelId) => void
  onKeyDown: (event: KeyboardEvent, id: AppearancePanelId) => void
  registerRef: (node: HTMLButtonElement | null) => void
}) {
  return (
    <div role="listitem">
      <Button
        ref={registerRef}
        type="button"
        variant="ghost"
        aria-current={isSelected ? "true" : undefined}
        data-testid={`appearance-nav-item-${id}`}
        data-active={isSelected}
        tabIndex={isRoving ? 0 : -1}
        onClick={() => onSelect(id)}
        onKeyDown={(event) => onKeyDown(event, id)}
        className={cn(
          "h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left font-normal",
          "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{description}</span>
        </span>
      </Button>
    </div>
  )
}
