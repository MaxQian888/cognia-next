"use client"

/**
 * One board column — either a full column of cards or a collapsed vertical
 * strip.
 *
 * The strip is NOT a hidden column: it keeps its `useDroppable`, so a card can
 * still be dropped on it and the six-column lifecycle stays reachable at any
 * width. That is the whole reason collapsing was chosen over hiding — hiding a
 * column would silently remove a legal transition from the board.
 *
 * Which columns collapse is decided by `resolveColumnCollapsed`, not here: an
 * empty column collapses by default and an explicit click wins in either
 * direction.
 */

import { useDroppable } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react"
import { Fragment, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { columnDropId } from "@/lib/issues/board-model"
import { cn } from "@/lib/utils"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueStatusIcon, STATUS_COLUMN_TINT } from "../issue-glyphs"
import { IssueCard } from "./issue-card"

export interface BoardColumnProps {
  status: IssueStatus
  items: readonly UnifiedIssueItem[]
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
  /** `unifiedId`s with an agent run in flight. */
  runningIds?: ReadonlySet<string>
  selectedId?: string
  onSelect?: (unifiedId: string) => void
  onAddIssue?: (status: IssueStatus) => void
  collapsed: boolean
  onToggleCollapsed?: (status: IssueStatus) => void
  /** This column would refuse the card currently being dragged. */
  dimmed: boolean
  /**
   * Where a CROSS-column drop would insert, or null. Same-column reorders are
   * left to `verticalListSortingStrategy`, whose gap already says it — drawing
   * a line as well would double-signal one intent. A collapsed column renders
   * this as a single bar across the strip, since it has no cards to sit between.
   */
  insertionIndex: number | null
  statusLabel: string
  addLabel: string
  emptyText: string
  collapseLabel: string
  expandLabel: string
  /** Wraps each card, so the board can attach the shared context menu. */
  renderItemMenu?: (item: UnifiedIssueItem, children: ReactNode) => ReactNode
}

export function BoardColumn({
  status,
  items,
  labelsById,
  projectNamesById,
  runningIds,
  selectedId,
  onSelect,
  onAddIssue,
  collapsed,
  onToggleCollapsed,
  dimmed,
  insertionIndex,
  statusLabel,
  addLabel,
  emptyText,
  collapseLabel,
  expandLabel,
  renderItemMenu,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDropId(status), disabled: dimmed })

  const shellClass = cn(
    "flex shrink-0 flex-col rounded-xl border",
    "motion-safe:transition-[opacity,width] motion-safe:duration-200",
    STATUS_COLUMN_TINT[status],
    dimmed && "pointer-events-none opacity-40",
    isOver && !dimmed && "ring-ring/50 ring-2"
  )

  if (collapsed) {
    return (
      <section
        ref={setNodeRef}
        role="listitem"
        aria-label={statusLabel}
        data-testid={`issue-column-${status}`}
        data-collapsed="true"
        data-dimmed={dimmed || undefined}
        className={cn(shellClass, "w-11 items-center py-2")}
      >
        {/*
          A strip is still a landing spot, and because the default collapse
          rule is "collapse iff empty", dropping onto one is the MOST common
          cross-column move on this board. The bar spans the strip rather than
          sitting between cards — expanding the column mid-drag would shift the
          layout out from under the pointer.
        */}
        {insertionIndex !== null ? (
          <div
            aria-hidden
            data-testid={`issue-drop-indicator-${status}`}
            className="mb-1.5 h-0.5 w-6 shrink-0 rounded-full bg-primary"
          />
        ) : null}
        <button
          type="button"
          onClick={() => onToggleCollapsed?.(status)}
          aria-label={expandLabel}
          title={expandLabel}
          data-testid={`issue-column-expand-${status}`}
          className="focus-visible:ring-ring/50 flex min-h-0 flex-1 flex-col items-center gap-2 rounded-lg px-1 focus-visible:outline-none focus-visible:ring-[3px]"
        >
          <IssueStatusIcon status={status} />
          <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
          <span className="min-h-0 flex-1 overflow-hidden text-xs font-semibold [writing-mode:vertical-rl]">
            {statusLabel}
          </span>
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </section>
    )
  }

  const cards = items.map((item) => {
    const card = (
      <IssueCard
        item={item}
        labels={item.labelIds
          .map((id) => labelsById?.get(id))
          .filter((label): label is LabelRow => Boolean(label))}
        projectName={item.issueProjectId ? projectNamesById?.get(item.issueProjectId) : undefined}
        selected={selectedId === item.unifiedId}
        running={runningIds?.has(item.unifiedId)}
        onSelect={onSelect}
      />
    )
    return renderItemMenu ? renderItemMenu(item, card) : card
  })

  const indicator = (
    <div
      aria-hidden
      data-testid={`issue-drop-indicator-${status}`}
      className="h-0.5 shrink-0 rounded-full bg-primary"
    />
  )

  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={statusLabel}
      data-testid={`issue-column-${status}`}
      data-dimmed={dimmed || undefined}
      className={cn(shellClass, "w-66")}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <IssueStatusIcon status={status} />
        <h2 className="min-w-0 truncate text-sm font-semibold">{statusLabel}</h2>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{items.length}</span>
        <span className="flex-1" />
        {onAddIssue ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label={addLabel}
            onClick={() => onAddIssue(status)}
            data-testid={`issue-column-add-${status}`}
          >
            <PlusIcon className="size-4" />
          </Button>
        ) : null}
        {onToggleCollapsed ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label={collapseLabel}
            title={collapseLabel}
            onClick={() => onToggleCollapsed(status)}
            data-testid={`issue-column-collapse-${status}`}
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext
          items={items.map((item) => item.unifiedId)}
          strategy={verticalListSortingStrategy}
        >
          {items.length === 0 && insertionIndex === null ? (
            <p className="py-8 text-center text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            cards.map((card, index) => (
              <Fragment key={items[index].unifiedId}>
                {insertionIndex === index ? indicator : null}
                {card}
              </Fragment>
            ))
          )}
          {insertionIndex !== null && insertionIndex >= items.length ? indicator : null}
        </SortableContext>
      </div>
    </section>
  )
}
