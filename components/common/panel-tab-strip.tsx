"use client"

/**
 * Shared panel tab strip.
 *
 * The narrowing contract, previously copied into `components/settings/mcp/
 * mcp-panel-tabs.tsx` and `components/skills/skill-panel-tabs.tsx` and absent
 * from every other multi-tab panel:
 *
 * - **No `overflow-x-auto` of our own.** An unbounded width lets the `w-fit`
 *   list render at max-content and overflow a narrow pane, which is what
 *   produced the horizontal scrollbar under the tabs and the scroll-into-view
 *   jitter when a half-hidden tab was clicked.
 * - **Triggers shrink instead.** `min-w-0 flex-initial` overrides the base
 *   `flex-1`, and the label truncates: compact when there is room, narrow when
 *   there isn't, never scrolling.
 *
 * `TabsList` still inherits `[[data-settings-panel]_&]:overflow-x-auto` from
 * `tabsListVariants` when it renders inside the settings shell. That rule is
 * inert here, because triggers that shrink never overflow and so there is
 * nothing to scroll. It matters for the surfaces this strip is reused on
 * *outside* the settings shell (the mobile `SubPageShell`, panels, sheets),
 * where the `data-settings-panel` rules do not apply at all and a bare
 * `TabsList` would overflow the viewport.
 *
 * Labels arrive already translated. This is a presentational primitive and
 * owns no i18n namespace.
 */

import type { ComponentType, ReactNode } from "react"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export interface PanelTab<TId extends string> {
  id: TId
  /** Already-translated label. Truncates when the strip runs out of room. */
  label: string
  icon?: ComponentType<{ className?: string }>
  /** Rendered after the label (a count badge, a dot). Must not grow. */
  badge?: ReactNode
}

export interface PanelTabStripProps<TId extends string> {
  tabs: readonly PanelTab<TId>[]
  value: TId
  onValueChange: (value: TId) => void
  /** Applied to the `Tabs` root. */
  className?: string
  /**
   * Applied to an element wrapping the `TabsList`, for the padding a panel
   * header needs. Omitted entirely when not given, so callers that want the
   * list as a direct child of `Tabs` keep that shape.
   */
  listWrapperClassName?: string
  /** `TabsContent` panels, when the caller renders content through this strip. */
  children?: ReactNode
}

export function PanelTabStrip<TId extends string>({
  tabs,
  value,
  onValueChange,
  className,
  listWrapperClassName,
  children,
}: PanelTabStripProps<TId>) {
  const list = (
    <TabsList className="max-w-full">
      {tabs.map((tab) => {
        const Icon = tab.icon
        return (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className="min-w-0 flex-initial text-xs"
            data-testid={`panel-tab-${tab.id}`}
          >
            {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{tab.label}</span>
            {tab.badge}
          </TabsTrigger>
        )
      })}
    </TabsList>
  )

  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next as TId)}
      className={cn(className)}
    >
      {listWrapperClassName ? <div className={listWrapperClassName}>{list}</div> : list}
      {children}
    </Tabs>
  )
}
