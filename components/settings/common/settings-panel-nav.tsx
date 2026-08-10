"use client"

/**
 * Grouped secondary nav for a settings master/detail pane.
 *
 * Markup follows `appearance-nav.tsx` (uppercase group header above
 * `role="listitem"` buttons — deliberately NOT `role="tab"`, this is a list
 * driving a detail pane). Motion follows `memory-nav.tsx`: the selection pill
 * is its own layer moved by shared layout, so it slides between rows instead of
 * every row cross-fading its background.
 *
 * Generic because Gateway and External Bridge shipped byte-identical copies of
 * it — the sixth and seventh `*-nav.tsx` under `components/settings/`, differing
 * only in the translation namespace, the `layoutId`, the testid prefix and the
 * id type. Everything that actually varies is a prop; nothing else should be
 * copied again.
 */

import { motion } from "motion/react"
import type { ComponentType } from "react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { STAGGER_CHILD, STAGGER_CONTAINER, MOBILE_SPRING } from "@/lib/ui/motion"

/** Small counters/markers surfaced on a row so they are visible from any panel. */
export interface SettingsNavBadge {
  text: string
  variant?: "secondary" | "destructive" | "outline"
  /**
   * What the badge means, for assistive tech. Required because the glyph alone
   * does not say it: Gateway's keys badge is a bare `!`, which a screen reader
   * otherwise announces as "exclamation mark" appended to the row's own label.
   */
  ariaLabel: string
}

export interface SettingsNavItem<Id extends string> {
  id: Id
  icon: ComponentType<{ className?: string }>
}

export interface SettingsNavGroup<Id extends string, GroupId extends string> {
  id: GroupId
  items: readonly SettingsNavItem<Id>[]
}

/**
 * Resolved strings, supplied by the caller.
 *
 * Not a next-intl namespace: `useTranslations(someString)` cannot be narrowed,
 * so every `t()` here would lose its key checking and need an args cast. The
 * binding components call `useTranslations` with a literal instead, which keeps
 * the message keys type-checked where they are actually written.
 */
export interface SettingsNavLabels<Id extends string, GroupId extends string> {
  title: string
  group: (groupId: GroupId) => string
  item: (id: Id) => { label: string; description: string }
}

export interface SettingsPanelNavProps<Id extends string, GroupId extends string> {
  groups: readonly SettingsNavGroup<Id, GroupId>[]
  activeId: Id
  onSelect: (id: Id) => void
  badges?: Partial<Record<Id, SettingsNavBadge>>
  labels: SettingsNavLabels<Id, GroupId>
  /**
   * Prefix for `data-testid` and the shared-layout pill. Two navs mounted with
   * the same value would fight over one `layoutId`, so it doubles as the
   * uniqueness key rather than being derived from it.
   */
  idPrefix: string
}

export function SettingsPanelNav<Id extends string, GroupId extends string>({
  groups,
  activeId,
  onSelect,
  badges = {} as Partial<Record<Id, SettingsNavBadge>>,
  labels,
  idPrefix,
}: SettingsPanelNavProps<Id, GroupId>) {
  const { reduce } = useFlowMotion()

  return (
    <motion.div
      role="list"
      aria-label={labels.title}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1"
      variants={reduce ? undefined : STAGGER_CONTAINER}
      initial={reduce ? undefined : "initial"}
      animate={reduce ? undefined : "animate"}
    >
      {groups.map((group) => (
        <div key={group.id}>
          <div
            className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            data-testid={`${idPrefix}-nav-group-${group.id}`}
          >
            {labels.group(group.id)}
          </div>
          {group.items.map((item) => (
            <SettingsNavRow
              key={item.id}
              id={item.id}
              icon={item.icon}
              label={labels.item(item.id).label}
              description={labels.item(item.id).description}
              isSelected={item.id === activeId}
              badge={badges[item.id]}
              reduce={reduce}
              idPrefix={idPrefix}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </motion.div>
  )
}

function SettingsNavRow<Id extends string>({
  id,
  icon: Icon,
  label,
  description,
  isSelected,
  badge,
  reduce,
  idPrefix,
  onSelect,
}: {
  id: Id
  icon: ComponentType<{ className?: string }>
  label: string
  description: string
  isSelected: boolean
  badge?: SettingsNavBadge
  reduce: boolean
  idPrefix: string
  onSelect: (id: Id) => void
}) {
  return (
    <motion.div role="listitem" variants={reduce ? undefined : STAGGER_CHILD} className="relative">
      {/* Own layer so the pill slides between rows via shared layout. Under
          `reduce` only one element may ever carry a given layoutId, so the pill
          is dropped entirely and the row paints its own background instead. */}
      {isSelected && !reduce ? (
        <motion.div
          layoutId={`${idPrefix}-nav-pill`}
          transition={MOBILE_SPRING}
          className="absolute inset-0 rounded-md bg-accent"
          aria-hidden
        />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        aria-current={isSelected ? "true" : undefined}
        data-testid={`${idPrefix}-nav-item-${id}`}
        data-active={isSelected}
        onClick={() => onSelect(id)}
        className={cn(
          "relative h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left font-normal",
          "transition-[transform,background-color] duration-150",
          "hover:translate-x-0.5 hover:bg-accent/50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isSelected && (reduce ? "bg-accent text-accent-foreground" : "text-accent-foreground")
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{description}</span>
        </span>
        {badge ? (
          <Badge
            variant={badge.variant ?? "secondary"}
            className="mt-0.5 shrink-0 px-1.5 text-[10px]"
            data-testid={`${idPrefix}-nav-badge-${id}`}
            aria-label={badge.ariaLabel}
          >
            <span aria-hidden>{badge.text}</span>
          </Badge>
        ) : null}
      </Button>
    </motion.div>
  )
}
