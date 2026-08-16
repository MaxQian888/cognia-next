"use client"

/**
 * Grouped list view — the `Display → Group by` counterpart to the board.
 *
 * Grouping and ordering are already resolved by `buildIssueGroups`; this
 * component only renders. Group headers are localized here because
 * `buildIssueGroups` returns raw keys (statuses, actor keys, priorities, or a
 * project id) and must stay free of i18n to remain unit-testable.
 */

import { useTranslations } from "next-intl"

import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { actorKey, type IssueGroup, type IssueGroupBy } from "@/lib/issues/board-model"
import { cn } from "@/lib/utils"
import type { IssuePriority, IssueStatus } from "@/types/issues"
import type { LabelRow } from "@/types/labels"
import { IssuePriorityIcon, IssueStatusIcon } from "./issue-glyphs"

export interface IssueListProps {
  groups: readonly IssueGroup[]
  groupBy: IssueGroupBy
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
  selectedId?: string
  onSelect?: (unifiedId: string) => void
}

export function IssueList({
  groups,
  groupBy,
  labelsById,
  projectNamesById,
  selectedId,
  onSelect,
}: IssueListProps) {
  const t = useTranslations("issues")

  /** Localize a raw group key. `""` is the catch-all bucket. */
  function groupLabel(key: string): string {
    if (key === "") {
      return groupBy === "assignee" ? t("actor.unassigned") : t("toolbar.groupBy.none")
    }
    switch (groupBy) {
      case "status":
        return t(`status.${key as IssueStatus}`)
      case "priority":
        return t(`priority.${key as IssuePriority}`)
      case "project":
        return projectNamesById?.get(key) ?? key
      case "assignee":
        return key.startsWith("human:") ? t("actor.human") : key.split(":")[1]
      default:
        return key
    }
  }

  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  if (total === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground" data-testid="issue-list-empty">
        {t("board.empty")}
      </p>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="issue-list">
      {groups.map((group) => (
        <section key={group.key || "__none"} data-testid={`issue-group-${group.key || "none"}`}>
          {groupBy === "none" ? null : (
            <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {groupLabel(group.key)}
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {group.items.length}
              </span>
            </header>
          )}

          <ul>
            {group.items.map((item) => {
              const labels = item.labelIds
                .map((id) => labelsById?.get(id))
                .filter((label): label is LabelRow => Boolean(label))

              return (
                <li key={item.unifiedId}>
                  <button
                    type="button"
                    onClick={() => onSelect?.(item.unifiedId)}
                    aria-pressed={selectedId === item.unifiedId}
                    data-testid={`issue-row-${item.unifiedId}`}
                    className={cn(
                      "flex w-full items-center gap-3 border-b px-4 py-2.5 text-left transition-colors",
                      "hover:bg-accent/50 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]",
                      selectedId === item.unifiedId && "bg-accent"
                    )}
                  >
                    {item.priority !== "none" ? (
                      <IssuePriorityIcon priority={item.priority} />
                    ) : (
                      <span aria-hidden className="size-3.5 shrink-0" />
                    )}
                    <IssueStatusIcon status={item.status} />
                    <span className="w-20 shrink-0 truncate font-mono text-xs text-muted-foreground">
                      {item.identifier}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>

                    {labels.slice(0, 2).map((label) => (
                      <LabelChip key={label.id} label={label} className="h-5 text-[10px]" />
                    ))}
                    {item.kind !== "local" ? (
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                        {t(`source.${item.kind}`)}
                      </Badge>
                    ) : null}

                    <span
                      className={cn(
                        "w-24 shrink-0 truncate text-right text-xs text-muted-foreground",
                        !item.assignee && "italic opacity-70"
                      )}
                      data-testid={`issue-row-assignee-${actorKey(item.assignee) ?? "none"}`}
                    >
                      {item.assignee
                        ? (item.assignee.label ?? t(`actor.${item.assignee.kind}`))
                        : t("actor.unassigned")}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
