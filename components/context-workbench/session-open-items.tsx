"use client"

import { ChevronRightIcon, CircleHelpIcon, ListChecksIcon, SquareDashedIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { WorkingSetEntry } from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** How many entries the compact card shows before deferring to the run context. */
export const COMPACT_OPEN_ITEM_LIMIT = 3

export interface SessionOpenItemsProps {
  entries: readonly WorkingSetEntry[]
  onNavigate: (panelId: string) => void
  compact?: boolean
  className?: string
}

/**
 * Select the working-set entries that represent *unfinished* work.
 *
 * Exported because it is the one definition of "open item" both surfaces share,
 * and the summary card's own test asserts against it rather than re-deriving
 * the filter.
 */
export function selectOpenItems(
  entries: readonly WorkingSetEntry[] | undefined
): WorkingSetEntry[] {
  return (entries ?? []).filter(
    (entry) =>
      entry.status === "active" && (entry.kind === "open-question" || entry.kind === "subtask")
  )
}

/**
 * Open questions and subtasks recorded in the session's working set.
 *
 * The compact card had no route to these at all — they existed only inside the
 * full overview panel — so a conversation blocked on an unanswered question
 * looked identical to one with nothing outstanding.
 */
export function SessionOpenItems({
  entries,
  onNavigate,
  compact = false,
  className,
}: SessionOpenItemsProps) {
  const t = useTranslations("contextWorkbench.taskOverview")
  const items = selectOpenItems(entries)
  const shown = compact ? items.slice(0, COMPACT_OPEN_ITEM_LIMIT) : items
  const hidden = items.length - shown.length
  return (
    <section className={cn("space-y-1.5", className)} aria-label={t("openItems")}>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
        <h3
          className={cn("flex items-center gap-1.5 font-medium", compact ? "text-xs" : "text-sm")}
        >
          <ListChecksIcon className="size-3.5 text-muted-foreground" aria-hidden />
          {t("openItems")}
          {items.length > 0 ? (
            <span className="rounded-pill bg-warning/15 px-1.5 text-[11px] font-medium tabular-nums text-foreground">
              {items.length}
            </span>
          ) : null}
        </h3>
        {/* At the summary column's 280px the heading plus its count already
            fills the row, so the route to the run context is an affordance
            rather than a second line of prose. The label survives as the
            accessible name. */}
        {compact ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={t("openContext")}
            title={t("openContext")}
            onClick={() => onNavigate("run-context")}
          >
            <ChevronRightIcon className="size-3.5" aria-hidden />
          </Button>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("run-context")}>
            {t("openContext")}
          </Button>
        )}
      </div>
      {shown.length ? (
        <ul className="space-y-1">
          {shown.map((entry) => {
            const Icon = entry.kind === "open-question" ? CircleHelpIcon : SquareDashedIcon
            return (
              <li
                key={entry.id}
                className={cn("flex items-start gap-1.5", compact ? "text-xs" : "text-sm")}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    entry.kind === "open-question" ? "text-warning" : "text-info"
                  )}
                  aria-hidden
                />
                <span className="min-w-0 break-words">{entry.summary}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("noOpenItems")}</p>
      )}
      {hidden > 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("openItemsMore", { count: hidden })}</p>
      ) : null}
    </section>
  )
}
