"use client"

/**
 * The scheduler list pane (ADR-0179 §4): search, the filter bar, a bulk
 * strip while anything is checked, then one flat run of rows.
 *
 * Two exports, same as the inbox: `SchedulerListPane` is the bare content
 * for the desktop resizable panel; `SchedulerListSidebar` wraps it in the
 * collapsible `<Sidebar>` chrome the tablet tier uses.
 *
 * Nothing here decides order or which rows are visible. The page hands over
 * `items` already filtered and ordered, and `signalByItem` from
 * `deriveAttention`, so this pane cannot disagree with the overview about
 * what needs the user.
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { AlertTriangleIcon, SearchIcon, XIcon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import type { AttentionSignal } from "@/lib/scheduler/attention"
import { duplicateNames } from "@/lib/scheduler/duplicate-names"
import type { SchedulerListFilterState } from "@/hooks/scheduler/use-scheduler-list-filter"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"

import { TaskListEmptyState } from "./empty-states"
import { SchedulerFilterBar } from "./scheduler-filter-bar"
import { SchedulerListRow } from "./scheduler-list-row"
import { LAYOUT_ANIMATION_ROW_LIMIT, listItemVariants, staticIf } from "./scheduler-motion"

export interface SchedulerListPaneProps {
  /** Filtered and ordered; what the rows render. */
  items: readonly UnifiedScheduledItem[]
  /** Every item before filtering, for the footer's "N of M". */
  totalCount: number
  filter: SchedulerListFilterState
  signalByItem: ReadonlyMap<string, AttentionSignal | null>
  sourceErrors: Partial<Record<ScheduledItemKind, unknown>>
  selectedId: string | null
  highlightedId?: string | null
  checkedIds: readonly string[]
  onSelect: (item: UnifiedScheduledItem) => void
  onToggleCheck: (item: UnifiedScheduledItem) => void
  /** Check every visible row. */
  onCheckAll: () => void
  onClearChecks: () => void
  onCreate: () => void
  /** The bulk toolbar, mounted by the page so it can own the confirm dialog. */
  bulkToolbar?: React.ReactNode
  /**
   * An item that was just added (by the user, a template, a clone or an
   * agent). Its row is scrolled into view and ringed until the page clears it.
   */
  justCreatedId?: string | null
}

export function SchedulerListSidebar(props: SchedulerListPaneProps) {
  return (
    <Sidebar collapsible="offcanvas" className="border-r">
      <SchedulerListPane {...props} />
    </Sidebar>
  )
}

export function SchedulerListPane({
  items,
  totalCount,
  filter,
  signalByItem,
  sourceErrors,
  selectedId,
  highlightedId,
  checkedIds,
  onSelect,
  onToggleCheck,
  onCheckAll,
  onClearChecks,
  onCreate,
  bulkToolbar,
  justCreatedId = null,
}: SchedulerListPaneProps) {
  const t = useTranslations("scheduler")
  const tList = useTranslations("scheduler.list")
  const reduceMotion = useReducedMotion()
  const rowVariants = staticIf(reduceMotion, listItemVariants)
  // Rows glide to their new place when attention re-orders the list, instead
  // of jumping. Off for long lists (every re-order measures every row) and for
  // reduced motion.
  const animateLayout = !reduceMotion && items.length <= LAYOUT_ANIMATION_ROW_LIMIT
  const listRef = useRef<HTMLDivElement>(null)

  // A new row can land far down a long list; bring it into view once.
  useEffect(() => {
    if (!justCreatedId || !listRef.current) return
    const row = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-item-id]")).find(
      (element) => element.dataset.itemId === justCreatedId
    )
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" })
    }
  }, [justCreatedId, reduceMotion])
  const checked = useMemo(() => new Set(checkedIds), [checkedIds])
  // Shared with the ⌘K palette (`lib/global-search/providers/system.ts`).
  const sharedNames = useMemo(() => duplicateNames(items), [items])
  const checkMode = checked.size > 0
  const allVisibleChecked = items.length > 0 && items.every((item) => checked.has(item.unifiedId))

  const failedKinds = useMemo(() => {
    const kinds = (Object.keys(sourceErrors) as ScheduledItemKind[]).filter(
      (kind) => sourceErrors[kind] !== undefined
    )
    return kinds.length > 0 ? kinds.map((kind) => t(`kindFilter.${kind}`)).join(", ") : null
  }, [sourceErrors, t])

  const handleCheckAll = useCallback(
    (next: boolean | "indeterminate") => {
      if (next === true) onCheckAll()
      else onClearChecks()
    },
    [onCheckAll, onClearChecks]
  )

  const hasNothingAtAll = totalCount === 0
  const isFilteredEmpty = totalCount > 0 && items.length === 0
  const isNarrowed = filter.isFiltering && items.length !== totalCount

  return (
    <>
      <SidebarHeader className="gap-2 px-3 pt-3 pb-1">
        <InputGroup className="h-8">
          <InputGroupAddon align="inline-start">
            <SearchIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            value={filter.filter.search}
            onChange={(event) => filter.setSearch(event.target.value)}
            placeholder={t("searchTasks")}
            aria-label={t("searchTasks")}
            className="text-xs"
            data-testid="scheduler-search"
          />
          {filter.filter.search ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => filter.setSearch("")}
                aria-label={t("clearSearch")}
                data-testid="scheduler-search-clear"
              >
                <XIcon className="size-3" />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <SchedulerFilterBar
          status={filter.filter.status}
          onStatusChange={filter.setStatus}
          statusCounts={filter.facets.statusCounts}
          selectedKinds={filter.kinds}
          onToggleKind={filter.toggleKind}
          countsByKind={filter.facets.countsByKind}
          loopOnly={filter.filter.loopOnly}
          onLoopOnlyChange={filter.setLoopOnly}
          loopCount={filter.facets.loopCount}
          onClearKindFilters={filter.clearKindFilters}
        />
      </SidebarHeader>

      <SidebarContent className="min-h-0 gap-0">
        {checkMode ? (
          <div
            className="sticky top-0 z-20 flex items-center gap-2 border-b bg-background/95 px-3 py-1.5 text-[11px] backdrop-blur"
            data-testid="scheduler-check-strip"
          >
            <Checkbox
              checked={allVisibleChecked ? true : checked.size > 0 ? "indeterminate" : false}
              onCheckedChange={handleCheckAll}
              aria-label={tList("checkAll")}
              className="size-3.5"
              data-testid="scheduler-check-all"
            />
            <span className="tabular-nums text-muted-foreground">
              {tList("checkedCount", { count: checked.size })}
            </span>
            <button
              type="button"
              onClick={onClearChecks}
              className="ml-auto text-primary underline-offset-2 hover:underline"
              data-testid="scheduler-check-clear"
            >
              {t("clearSelection")}
            </button>
          </div>
        ) : null}
        {bulkToolbar}

        {failedKinds ? (
          <Surface
            layer="raised"
            radius="control"
            role="status"
            data-testid="scheduler-source-errors"
            className="mx-3 my-2 flex items-start gap-2 border border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-600 dark:text-amber-400"
          >
            <AlertTriangleIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span>{t("sourceLoadFailed", { kinds: failedKinds })}</span>
          </Surface>
        ) : null}

        {hasNothingAtAll ? <TaskListEmptyState onCreate={onCreate} /> : null}
        {isFilteredEmpty ? (
          <TaskListEmptyState variant="filtered" onClearFilters={filter.reset} />
        ) : null}

        {items.length > 0 ? (
          <div
            ref={listRef}
            className="relative flex flex-col px-1.5 py-1"
            role="list"
            data-testid="scheduler-list"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((item) => (
                <motion.div
                  key={item.unifiedId}
                  role="listitem"
                  layout={animateLayout ? "position" : false}
                  variants={rowVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  transition={{ layout: { duration: 0.22, ease: "easeOut" } }}
                  data-item-id={item.unifiedId}
                  data-just-created={justCreatedId === item.unifiedId || undefined}
                  className={cn(
                    "rounded-md ring-inset transition-[box-shadow] duration-700",
                    justCreatedId === item.unifiedId && "ring-2 ring-primary/50"
                  )}
                >
                  <SchedulerListRow
                    item={item}
                    showIdentity={sharedNames.has(item.name)}
                    signal={signalByItem.get(item.unifiedId) ?? null}
                    selected={selectedId === item.unifiedId}
                    highlighted={highlightedId === item.unifiedId}
                    checked={checked.has(item.unifiedId)}
                    checkMode={checkMode}
                    onSelect={onSelect}
                    onToggleCheck={onToggleCheck}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ) : null}
      </SidebarContent>

      <SidebarFooter>
        <div
          className="flex items-center gap-x-3 px-3 py-2 text-[11px] text-muted-foreground"
          data-testid="scheduler-list-footer"
        >
          <span className="tabular-nums" data-testid="scheduler-list-count">
            {isNarrowed
              ? t("sidebarFooter.filtered", { shown: items.length, total: totalCount })
              : t("sidebarFooter.total", { total: totalCount })}
          </span>
          {isNarrowed ? (
            <button
              type="button"
              onClick={filter.reset}
              className={cn("ml-auto shrink-0 text-primary underline-offset-2 hover:underline")}
              data-testid="scheduler-list-reset-filters"
            >
              {t("filterBar.clear")}
            </button>
          ) : null}
        </div>
      </SidebarFooter>
    </>
  )
}
