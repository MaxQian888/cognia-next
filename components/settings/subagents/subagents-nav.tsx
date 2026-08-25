"use client"

// Grouped nav for the Subagents section's master/detail layout, replacing the
// `templates | runtime` tab strip plus the 2-column card grid that used to
// carry every template. Markup mirrors `../appearance/components/appearance-nav.tsx`:
// uppercase group headers above `role="listitem"` buttons in a scrolling
// container. Deliberately not `role="tab"` — this is a list driving a detail
// pane, not a tablist.
//
// Two things this nav does that the Appearance one doesn't:
//
//  1. It owns the search + category filter chrome, because the entity groups
//     are long. The category chips are real pressed buttons —
//     the previous implementation used `<Badge onClick>`, which is neither
//     focusable nor announced as a toggle.
//  2. Every entity row's avatar carries `data-flight-source`, the measurement
//     anchor the FLIP ghost reads when the selection moves. Hover on these
//     dense rows translates rather than scales: a per-row `scale` in a tight
//     list visually crowds its neighbours.

import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { STAGGER_CHILD, STAGGER_CONTAINER, MOBILE_SPRING } from "@/lib/ui/motion"

import {
  SUBAGENT_STATIC_GROUPS,
  type SubagentNavEntityGroup,
  type SubagentPanelId,
} from "./nav-config"

export interface SubagentsNavProps {
  activeId: SubagentPanelId
  onSelect: (id: SubagentPanelId) => void
  /** Template / plugin rows, already filtered by search + category. */
  entityGroups: readonly SubagentNavEntityGroup[]
  /** Live (running) run count — badges the runtime row. */
  runningCount: number
  /** Panels holding unsaved edits; each gets a dot. */
  dirtyPanels?: readonly SubagentPanelId[]
  search: string
  onSearchChange: (value: string) => void
  categories: readonly string[]
  activeCategory: string | null
  onCategoryChange: (category: string | null) => void
  /** A filter is active and matched nothing — distinct from "nothing exists". */
  filteredEmpty?: boolean
}

export function SubagentsNav({
  activeId,
  onSelect,
  entityGroups,
  runningCount,
  dirtyPanels = [],
  search,
  onSearchChange,
  categories,
  activeCategory,
  onCategoryChange,
  filteredEmpty = false,
}: SubagentsNavProps) {
  const t = useTranslations("settings.subagents.nav")
  const tCategories = useTranslations("settings.subagents.templates.categories")
  const { reduce } = useFlowMotion()
  const dirty = new Set(dirtyPanels)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Filter chrome — pinned, so a long list scrolls under it. */}
      <div className="shrink-0 space-y-2 border-b p-2">
        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-8 pl-8 text-xs"
            data-testid="subagent-nav-search"
          />
          {search ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onSearchChange("")}
              className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={t("clearSearch")}
              data-testid="subagent-nav-search-clear"
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1" data-testid="subagent-category-filter">
          <CategoryChip
            label={t("filterAll")}
            pressed={activeCategory === null}
            onClick={() => onCategoryChange(null)}
            testId="category-filter-all"
          />
          {categories.map((category) => (
            <CategoryChip
              key={category}
              label={tCategories(category)}
              pressed={activeCategory === category}
              onClick={() => onCategoryChange(activeCategory === category ? null : category)}
              testId={`category-filter-${category}`}
            />
          ))}
        </div>
      </div>

      <motion.div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1"
        role="list"
        aria-label={t("title")}
        variants={reduce ? undefined : STAGGER_CONTAINER}
        initial={reduce ? undefined : "hidden"}
        animate={reduce ? undefined : "visible"}
      >
        {SUBAGENT_STATIC_GROUPS.map((group) => (
          <NavGroup key={group.id} label={t(`groups.${group.id}`)} testId={group.id}>
            {group.items.map((item) => (
              <NavRow
                key={item.id}
                panelId={item.id}
                label={t(`items.${item.id}.label`)}
                description={t(`items.${item.id}.description`)}
                icon={<item.icon className="size-4" />}
                isActive={activeId === item.id}
                isDirty={dirty.has(item.id)}
                badge={item.id === "runtime" && runningCount > 0 ? runningCount : undefined}
                onSelect={onSelect}
                reduce={reduce}
              />
            ))}
          </NavGroup>
        ))}

        {entityGroups.map((group) =>
          group.items.length === 0 ? null : (
            <NavGroup key={group.id} label={t(`groups.${group.id}`)} testId={group.id}>
              {group.items.map((item) => (
                <NavRow
                  key={item.panelId}
                  panelId={item.panelId}
                  label={item.label}
                  description={item.description}
                  glyph={item.glyph}
                  isActive={activeId === item.panelId}
                  isDirty={dirty.has(item.panelId)}
                  isDisabled={item.disabled}
                  isHidden={item.hidden}
                  onSelect={onSelect}
                  reduce={reduce}
                />
              ))}
            </NavGroup>
          )
        )}

        {filteredEmpty ? (
          <p
            className="px-3 py-6 text-center text-xs text-muted-foreground"
            data-testid="subagent-nav-empty"
          >
            {t("emptyFiltered")}
          </p>
        ) : null}
      </motion.div>
    </div>
  )
}

function CategoryChip({
  label,
  pressed,
  onClick,
  testId,
}: {
  label: string
  pressed: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "h-auto rounded-pill px-2 py-0.5 text-[10px] font-normal",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pressed
          ? "border-transparent bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      {label}
    </Button>
  )
}

function NavGroup({
  label,
  testId,
  children,
}: {
  label: string
  testId: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div
        className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        data-testid={`subagent-nav-group-${testId}`}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

interface NavRowProps {
  panelId: SubagentPanelId
  label: string
  description?: string
  /** Static rows pass a lucide icon; entity rows pass a glyph character. */
  icon?: React.ReactNode
  glyph?: string
  isActive: boolean
  isDirty: boolean
  isDisabled?: boolean
  isHidden?: boolean
  badge?: number
  onSelect: (id: SubagentPanelId) => void
  reduce: boolean
}

function NavRow({
  panelId,
  label,
  description,
  icon,
  glyph,
  isActive,
  isDirty,
  isDisabled,
  isHidden,
  badge,
  onSelect,
  reduce,
}: NavRowProps) {
  return (
    <motion.div
      role="listitem"
      layout={reduce ? false : "position"}
      variants={reduce ? undefined : STAGGER_CHILD}
      className="relative"
    >
      {/* Selection pill is its own layer so it can slide between rows via
          shared layout rather than each row cross-fading its background. */}
      {isActive && !reduce ? (
        <motion.div
          layoutId="subagent-nav-pill"
          transition={MOBILE_SPRING}
          className="absolute inset-0 rounded-md bg-accent"
          aria-hidden
        />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        aria-current={isActive ? "true" : undefined}
        data-testid={`subagent-nav-item-${panelId}`}
        data-active={isActive}
        data-disabled-entry={isDisabled ? "true" : undefined}
        onClick={() => onSelect(panelId)}
        className={cn(
          "relative h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left font-normal",
          "transition-[transform,background-color] duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // Dense list: translate on hover instead of scaling, which would
          // visually crowd the neighbouring rows.
          "hover:translate-x-0.5 hover:bg-accent/50",
          isActive && (reduce ? "bg-accent text-accent-foreground" : "text-accent-foreground"),
          isDisabled && "opacity-55"
        )}
      >
        <span className="mt-0.5 shrink-0" data-flight-source={panelId}>
          {icon ?? (
            <span
              className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[10px]"
              aria-hidden
            >
              {glyph}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn("min-w-0 truncate text-sm font-medium", isDisabled && "line-through")}
            >
              {label}
            </span>
            {isDirty ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-primary"
                data-testid={`subagent-nav-dirty-${panelId}`}
              />
            ) : null}
            {isHidden ? <EyeOffDot /> : null}
            {badge !== undefined ? (
              <span
                className="ml-auto shrink-0 rounded-pill bg-primary px-1.5 text-[10px] tabular-nums text-primary-foreground"
                data-testid={`subagent-nav-badge-${panelId}`}
              >
                {badge}
              </span>
            ) : null}
          </span>
          {description ? (
            <span className="block truncate text-[11px] text-muted-foreground">{description}</span>
          ) : null}
        </span>
      </Button>
    </motion.div>
  )
}

/** Small marker for `hidden` entries — dispatchable, but absent from pickers. */
function EyeOffDot() {
  return <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
}
