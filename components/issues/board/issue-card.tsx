"use client"

/**
 * One card on the issue board.
 *
 * A thin render shell — every decision it reflects (can this move? what does
 * its column look like? which labels apply?) is computed in
 * `lib/issues/board-model.ts` and handed down as props. Keep it that way: the
 * board's rules must stay testable without React or dnd-kit.
 *
 * Federated rows (GitHub mirrors, agent tasks) render with a source badge and
 * are NOT draggable — `capabilities.canMove` is the single gate, so a read-only
 * row can never acquire a drag affordance it would then fail to honour.
 *
 * SPLIT: the markup lives in `IssueCardVisual`, the dnd wiring in `IssueCard`.
 * The board's `<DragOverlay>` renders the visual alone — rendering a second
 * `IssueCard` would register a second sortable node under the same id, which
 * dnd-kit resolves by fighting with itself over the measured rect.
 */

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { FolderIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { KeyboardEvent } from "react"

import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { actorKey } from "@/lib/issues/board-model"
import type { SquadRunRef } from "@/lib/issues/run/running"
import { cn } from "@/lib/utils"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssuePriorityIcon, IssueStatusIcon } from "../issue-glyphs"
import { SquadRunChip } from "./squad-run-chip"

export interface IssueCardVisualProps {
  item: UnifiedIssueItem
  /** Resolved label rows for `item.labelIds`; unresolved ids are simply absent. */
  labels?: readonly LabelRow[]
  /** Display name for `item.issueProjectId`, when the caller can resolve it. */
  projectName?: string
  selected?: boolean
  /** An `IssueRunAdapter` run is in flight for this issue. */
  running?: boolean
  /** The Squad this issue was dispatched to, when any. */
  squadRun?: SquadRunRef
  /** The real card, dimmed while its clone rides the drag overlay. */
  dragging?: boolean
  /** The clone inside `<DragOverlay>` — lifted, and never marked selected. */
  overlay?: boolean
  draggable?: boolean
  className?: string
}

/**
 * The card's markup, with no dnd behaviour at all. Shared by the board card
 * and the drag overlay's clone so the two can never look different.
 */
export function IssueCardVisual({
  item,
  labels,
  projectName,
  selected,
  running,
  squadRun,
  dragging,
  overlay,
  draggable,
  className,
}: IssueCardVisualProps) {
  const t = useTranslations("issues")

  const assigneeLabel = item.assignee
    ? (item.assignee.label ?? t(`actor.${item.assignee.kind}`))
    : t("actor.unassigned")

  return (
    <div
      className={cn(
        "group flex w-full flex-col gap-2 rounded-lg border bg-card p-3 text-left shadow-xs",
        "motion-safe:transition-[box-shadow,opacity] motion-safe:duration-150",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        !overlay && "hover:shadow-sm",
        !overlay && selected && "ring-ring/60 ring-2",
        // The source card stays in place at low opacity so the column keeps its
        // height while the clone is away — removing it would collapse the list
        // under the pointer and make every drop target jump.
        dragging && "opacity-40",
        overlay && "cursor-grabbing rotate-1 shadow-lg ring-1 ring-border/60",
        className
      )}
    >
      <header className="flex items-center gap-2">
        <IssueStatusIcon status={item.status} />
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {item.identifier}
        </span>
        <span className="flex-1" />
        {running ? (
          <span
            aria-label={t("board.runningCard")}
            title={t("board.runningCard")}
            data-testid={`issue-card-running-${item.unifiedId}`}
            className="size-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse"
          />
        ) : null}
        {item.priority !== "none" ? <IssuePriorityIcon priority={item.priority} /> : null}
        {item.kind !== "local" ? (
          <Badge
            variant="outline"
            className="h-5 shrink-0 px-1.5 text-[10px] font-normal"
            title={t("source.readOnly", { source: t(`source.${item.kind}`) })}
          >
            {t(`source.${item.kind}`)}
          </Badge>
        ) : null}
      </header>

      <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{item.title}</h3>

      {labels && labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} className="h-5 text-[10px]" />
          ))}
        </div>
      ) : null}

      {squadRun ? <SquadRunChip run={squadRun} inert={overlay} className="self-start" /> : null}

      <footer className="flex items-center gap-2 text-xs text-muted-foreground">
        {projectName ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <FolderIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{projectName}</span>
          </span>
        ) : null}
        <span className="flex-1" />
        <span
          className={cn("truncate", !item.assignee && "italic opacity-70")}
          data-testid={`issue-card-assignee-${actorKey(item.assignee) ?? "none"}`}
        >
          {assigneeLabel}
        </span>
      </footer>
    </div>
  )
}

export interface IssueCardProps {
  item: UnifiedIssueItem
  labels?: readonly LabelRow[]
  projectName?: string
  selected?: boolean
  running?: boolean
  squadRun?: SquadRunRef
  onSelect?: (unifiedId: string) => void
}

export function IssueCard({
  item,
  labels,
  projectName,
  selected,
  running,
  squadRun,
  onSelect,
}: IssueCardProps) {
  const draggable = item.capabilities.canMove

  const sortable = useSortable({ id: item.unifiedId, disabled: !draggable })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable

  /**
   * Enter opens the card; Space is dnd-kit's. The board narrows the keyboard
   * sensor's activator to Space alone (see `issue-board.tsx`) precisely so this
   * split is possible — dnd-kit's default claims Enter too, which would leave
   * a keyboard user able to drag a card but never to open one.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    listeners?.onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (event.key === "Enter") {
      event.preventDefault()
      onSelect?.(item.unifiedId)
    }
  }

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
      onClick={() => onSelect?.(item.unifiedId)}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-testid={`issue-card-${item.unifiedId}`}
      data-dragging={isDragging || undefined}
      className="focus-visible:ring-ring/50 rounded-lg focus-visible:outline-none focus-visible:ring-[3px]"
    >
      <IssueCardVisual
        item={item}
        labels={labels}
        projectName={projectName}
        selected={selected}
        running={running}
        squadRun={squadRun}
        dragging={isDragging}
        draggable={draggable}
      />
    </article>
  )
}
