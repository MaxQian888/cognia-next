"use client"

/**
 * Grouped list view — the `Display → Group by` counterpart to the board.
 *
 * Grouping and ordering are already resolved by `buildIssueGroups`; this
 * component renders and owns interaction. Group headers are localized here
 * because `buildIssueGroups` returns raw keys (statuses, actor keys, priorities
 * or a project id) and must stay free of i18n to remain unit-testable.
 *
 * Two things distinguish it from the old flat-button version: rows are a grid
 * with two densities instead of `w-20`/`w-24` guesses, and rows can be TICKED
 * for a bulk action independently of being SELECTED for the inspector. Those
 * are genuinely different intents — "show me this" and "include this in what I
 * am about to change" — and collapsing them is how a bulk edit surprises
 * someone.
 */

import { useTranslations } from "next-intl"
import { useEffect, useRef, type ReactNode } from "react"

import type { IssueGroup, IssueGroupBy } from "@/lib/issues/board-model"
import type { IssueListDensity } from "@/lib/issues/views"
import type { IssuePriority, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueRow } from "./issue-row"

export interface IssueListProps {
  groups: readonly IssueGroup[]
  groupBy: IssueGroupBy
  density?: IssueListDensity
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
  runningIds?: ReadonlySet<string>
  /** The row whose detail is open. */
  selectedId?: string
  onSelect?: (unifiedId: string) => void
  /** Rows ticked for a bulk action. */
  checkedIds?: ReadonlySet<string>
  onToggleCheck?: (unifiedId: string, modifiers: { shiftKey: boolean }) => void
  /** The keyboard cursor's row. */
  cursorId?: string
  /**
   * Wraps each row, so the console can attach the shared context menu without
   * this component knowing about labels, containers or assignees.
   */
  renderItemMenu?: (item: UnifiedIssueItem, children: ReactNode) => ReactNode
}

export function IssueList({
  groups,
  groupBy,
  density = "comfortable",
  labelsById,
  projectNamesById,
  runningIds,
  selectedId,
  onSelect,
  checkedIds,
  onToggleCheck,
  cursorId,
  renderItemMenu,
}: IssueListProps) {
  const t = useTranslations("issues")
  const scrollerRef = useRef<HTMLDivElement>(null)

  /**
   * Keep the keyboard cursor on screen. Without this, `j` past the fold moves
   * a row the user cannot see, which reads as the key doing nothing.
   */
  useEffect(() => {
    if (!cursorId) return
    const row = scrollerRef.current?.querySelector(`[data-testid="issue-row-${cursorId}"]`)
    row?.scrollIntoView({ block: "nearest" })
  }, [cursorId])

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
    <div
      ref={scrollerRef}
      className="@container/issue-list flex h-full min-h-0 flex-col overflow-y-auto"
      data-testid="issue-list"
      data-density={density}
    >
      {groups.map((group) => (
        <section key={group.key || "__none"} data-testid={`issue-group-${group.key || "none"}`}>
          {groupBy === "none" ? null : (
            <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {groupLabel(group.key)}
              </h2>
              <span className="text-xs tabular-nums text-muted-foreground">
                {group.items.length}
              </span>
            </header>
          )}

          <ul>
            {group.items.map((item) => {
              const row = (
                <IssueRow
                  item={item}
                  labels={item.labelIds
                    .map((id) => labelsById?.get(id))
                    .filter((label): label is LabelRow => Boolean(label))}
                  projectName={
                    item.issueProjectId ? projectNamesById?.get(item.issueProjectId) : undefined
                  }
                  density={density}
                  selected={selectedId === item.unifiedId}
                  checked={checkedIds?.has(item.unifiedId) ?? false}
                  cursored={cursorId === item.unifiedId}
                  running={runningIds?.has(item.unifiedId)}
                  selectable={Boolean(onToggleCheck)}
                  onOpen={() => onSelect?.(item.unifiedId)}
                  onToggleCheck={(modifiers) => onToggleCheck?.(item.unifiedId, modifiers)}
                />
              )
              return (
                <li key={item.unifiedId}>{renderItemMenu ? renderItemMenu(item, row) : row}</li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
