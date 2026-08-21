"use client"

/**
 * One row of the issue list.
 *
 * The old row was a flat `<button>` with `w-20` and `w-24` fixed-width spans,
 * so a long identifier and a long assignee name each truncated against a
 * guess rather than against the space actually available. This is a grid: the
 * title takes the slack, everything else is sized to its content, and the two
 * densities differ only in row padding and which columns survive.
 *
 * The whole row is NOT a button any more — it holds a checkbox and (via the
 * parent) a context menu, and nesting interactive controls inside a button is
 * invalid. Selection lives on an inner overlay button that fills the row, so
 * the click target is unchanged.
 */

import { useTranslations } from "next-intl"
import type { MouseEvent, ReactNode } from "react"

import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { actorKey } from "@/lib/issues/board-model"
import type { IssueListDensity } from "@/lib/issues/views"
import { cn } from "@/lib/utils"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssuePriorityIcon, IssueStatusIcon } from "../issue-glyphs"

/** How many label chips fit before the rest collapse into a "+N". */
const MAX_VISIBLE_LABELS = 2

export interface IssueRowProps {
  item: UnifiedIssueItem
  labels?: readonly LabelRow[]
  projectName?: string
  density: IssueListDensity
  selected: boolean
  /** Ticked for a bulk action — orthogonal to `selected`, which opens the inspector. */
  checked: boolean
  /** The keyboard cursor is on this row. */
  cursored: boolean
  running?: boolean
  /** Bulk selection is available at all (false for a federated-only list). */
  selectable?: boolean
  onOpen: () => void
  onToggleCheck: (event: { shiftKey: boolean }) => void
  /** Wraps the row so the parent can attach a context menu. */
  children?: ReactNode
}

export function IssueRow({
  item,
  labels,
  projectName,
  density,
  selected,
  checked,
  cursored,
  running,
  selectable = true,
  onOpen,
  onToggleCheck,
}: IssueRowProps) {
  const t = useTranslations("issues")
  const compact = density === "compact"

  const visibleLabels = labels?.slice(0, MAX_VISIBLE_LABELS) ?? []
  const hiddenLabelCount = Math.max(0, (labels?.length ?? 0) - visibleLabels.length)

  return (
    <div
      data-testid={`issue-row-${item.unifiedId}`}
      data-cursored={cursored || undefined}
      data-checked={checked || undefined}
      className={cn(
        "group/issue-row relative grid items-center gap-3 border-b px-4",
        "motion-safe:transition-colors motion-safe:duration-150",
        // checkbox · priority · status · id · title · labels · project · source · assignee
        "grid-cols-[auto_auto_auto_minmax(0,6rem)_minmax(0,1fr)_auto_auto_auto_minmax(0,9rem)]",
        compact ? "py-1" : "py-2.5",
        "hover:bg-accent/40",
        selected && "bg-accent",
        cursored && !selected && "bg-accent/50",
        checked && "bg-primary/5"
      )}
    >
      {selectable ? (
        <Checkbox
          checked={checked}
          onClick={(event: MouseEvent) => onToggleCheck({ shiftKey: event.shiftKey })}
          aria-label={t("list.select", { identifier: item.identifier })}
          data-testid={`issue-row-check-${item.unifiedId}`}
          className="shrink-0"
        />
      ) : (
        <span aria-hidden className="size-4 shrink-0" />
      )}

      {item.priority !== "none" ? (
        <IssuePriorityIcon priority={item.priority} />
      ) : (
        <span aria-hidden className="size-3.5 shrink-0" />
      )}

      <span className="flex shrink-0 items-center gap-1.5">
        <IssueStatusIcon status={item.status} />
        {running ? (
          <span
            aria-label={t("board.runningCard")}
            title={t("board.runningCard")}
            data-testid={`issue-row-running-${item.unifiedId}`}
            className="size-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse"
          />
        ) : null}
      </span>

      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
        {item.identifier}
      </span>

      {/*
        The TITLE is the button, and it stretches across the row's flexible
        column. Making the whole row a button is not an option — it holds a
        checkbox and a context menu, and nesting interactive controls inside a
        button is invalid markup that also swallows their clicks.
      */}
      <button
        type="button"
        onClick={onOpen}
        aria-pressed={selected}
        data-testid={`issue-row-open-${item.unifiedId}`}
        className="focus-visible:ring-ring/50 min-w-0 truncate rounded-sm text-left text-sm focus-visible:outline-none focus-visible:ring-[3px]"
      >
        {item.title}
      </button>

      <span className="flex shrink-0 items-center gap-1">
        {visibleLabels.map((label) => (
          <LabelChip key={label.id} label={label} className="h-5 text-[10px]" />
        ))}
        {hiddenLabelCount > 0 ? (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
            {t("list.moreLabels", { count: hiddenLabelCount })}
          </Badge>
        ) : null}
      </span>

      <span
        className={cn(
          "min-w-0 max-w-32 shrink-0 truncate text-xs text-muted-foreground",
          compact && "hidden @2xl/issue-list:block"
        )}
      >
        {projectName ?? ""}
      </span>

      <span className="shrink-0">
        {item.kind !== "local" ? (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
            {t(`source.${item.kind}`)}
          </Badge>
        ) : null}
      </span>

      <span
        className={cn(
          "min-w-0 truncate text-right text-xs text-muted-foreground",
          !item.assignee && "italic opacity-70"
        )}
        data-testid={`issue-row-assignee-${actorKey(item.assignee) ?? "none"}`}
      >
        {item.assignee
          ? (item.assignee.label ?? t(`actor.${item.assignee.kind}`))
          : t("actor.unassigned")}
      </span>
    </div>
  )
}
