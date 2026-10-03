"use client"

import { CircleHelpIcon, ListChecksIcon, SquareDashedIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { WorkingSetEntry } from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface SessionOpenItemsProps {
  entries: readonly WorkingSetEntry[]
  onNavigate: (panelId: string) => void
  className?: string
}

/**
 * Select the working-set entries that represent *unfinished* work.
 *
 * Exported because it is the one definition of "open item"; tests assert
 * against it rather than re-deriving the filter.
 */
export function selectOpenItems(
  entries: readonly WorkingSetEntry[] | undefined
): WorkingSetEntry[] {
  return (entries ?? []).filter(
    (entry) =>
      entry.status === "active" && (entry.kind === "open-question" || entry.kind === "subtask")
  )
}

/** Open questions and subtasks recorded in the session's working set. */
export function SessionOpenItems({ entries, onNavigate, className }: SessionOpenItemsProps) {
  const t = useTranslations("contextWorkbench.taskOverview")
  const items = selectOpenItems(entries)
  return (
    <section className={cn("space-y-1.5", className)} aria-label={t("openItems")}>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <ListChecksIcon className="size-3.5 text-muted-foreground" aria-hidden />
          {t("openItems")}
          {items.length > 0 ? (
            <span className="rounded-pill bg-warning/15 px-1.5 text-[11px] font-medium tabular-nums text-foreground">
              {items.length}
            </span>
          ) : null}
        </h3>
        <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("run-context")}>
          {t("openContext")}
        </Button>
      </div>
      {items.length ? (
        <ul className="space-y-1">
          {items.map((entry) => {
            const Icon = entry.kind === "open-question" ? CircleHelpIcon : SquareDashedIcon
            return (
              <li key={entry.id} className="flex items-start gap-1.5 text-sm">
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
    </section>
  )
}
