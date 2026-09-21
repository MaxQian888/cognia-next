"use client"

/**
 * The issues board's collapsed column: an icon-width rail.
 *
 * A collapsed column used to write its label vertically
 * (`writing-mode: vertical-rl`), which read poorly and told you nothing
 * about what was inside. The rail drops the text entirely — identity comes
 * from the status glyph + tint, a priority-coloured "spine" sketches the
 * column's contents, and the label plus clickable item rows live in a
 * hover card. Everything the old strip did still works: the whole rail is
 * the expand button, quick-add sits at the bottom, and the board's
 * `<section>` shell keeps it a drop target.
 */

import { ChevronRightIcon, PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"

import type { KanbanCollapsedContext, KanbanCollapsedStrip } from "@/components/board/kanban-board"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import type { IssuePriority, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { IssuePriorityIcon } from "../issue-glyphs"

type RailContext = KanbanCollapsedContext<IssueStatus, UnifiedIssueItem>

/** Dot colour per priority for the rail's item spine. */
const PRIORITY_DOT: Record<IssuePriority, string> = {
  urgent: "bg-red-500",
  high: "bg-foreground/70",
  medium: "bg-foreground/40",
  low: "bg-muted-foreground/40",
  none: "bg-muted-foreground/25",
}

/** The spine sketches at most this many items before the dots lose meaning. */
const SPINE_LIMIT = 12
/**
 * Item rows listed in the hover card's scroll area before an overflow row
 * takes over. High enough that a collapsed column's contents are one hover
 * away for any realistic board, bounded so the DOM stays cheap.
 */
const PREVIEW_LIMIT = 50

export interface IssueCollapsedRailExtras {
  /** `unifiedId`s with an agent run in flight — flags the rail and its rows. */
  runningIds?: ReadonlySet<string>
  /** Opens an item straight from the hover card's rows. */
  onSelect?: (unifiedId: string) => void
  /** Wraps each preview row, so a right-click gets the issue context menu. */
  renderItemMenu?: (item: UnifiedIssueItem, children: ReactNode) => ReactNode
}

export function issueCollapsedRail(
  ctx: RailContext,
  extras: IssueCollapsedRailExtras = {}
): KanbanCollapsedStrip {
  return {
    className: "w-12 items-center py-2",
    content: <CollapsedRailContent ctx={ctx} {...extras} />,
  }
}

function CollapsedRailContent({
  ctx,
  runningIds,
  onSelect,
  renderItemMenu,
}: { ctx: RailContext } & IssueCollapsedRailExtras) {
  const t = useTranslations("board")
  const hasRunning =
    runningIds !== undefined && ctx.items.some((item) => runningIds.has(item.unifiedId))

  return (
    <>
      {ctx.insertionIndex !== null ? (
        <div
          aria-hidden
          data-testid={`${ctx.testIdPrefix}-drop-indicator-${ctx.columnId}`}
          className="mb-1 h-0.5 w-6 shrink-0 rounded-full bg-primary"
        />
      ) : null}
      <HoverCard openDelay={150} closeDelay={100}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            onClick={ctx.onExpand}
            aria-label={ctx.expandLabel}
            title={ctx.expandLabel}
            data-testid={`${ctx.testIdPrefix}-column-expand-${ctx.columnId}`}
            className={cn(
              "focus-visible:ring-ring/50 flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 rounded-lg px-1 focus-visible:outline-none focus-visible:ring-[3px]",
              ctx.isOver && "bg-accent/50"
            )}
          >
            <span className="relative">
              {ctx.icon}
              {hasRunning ? (
                <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
              ) : null}
            </span>
            <span
              data-testid={`${ctx.testIdPrefix}-column-${ctx.columnId}-count`}
              className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
            >
              {ctx.count}
            </span>
            <span
              aria-hidden
              className="flex min-h-0 flex-1 flex-col items-center justify-start gap-1 overflow-hidden py-1"
            >
              {ctx.items.slice(0, SPINE_LIMIT).map((item) => (
                <span
                  key={item.unifiedId}
                  className={cn("h-1 w-4 shrink-0 rounded-full", PRIORITY_DOT[item.priority])}
                />
              ))}
            </span>
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          side="right"
          align="start"
          collisionPadding={8}
          className="flex max-h-[70vh] w-72 flex-col overflow-hidden p-2"
        >
          <header className="flex items-center gap-2 px-1.5 pb-1.5">
            {ctx.icon}
            <span className="min-w-0 truncate text-xs font-semibold">{ctx.label}</span>
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {ctx.count}
            </span>
          </header>
          {ctx.items.length === 0 ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">{t("emptyColumn")}</p>
          ) : (
            <div className="min-h-0 overflow-y-auto">
              <RailItemRows
                ctx={ctx}
                runningIds={runningIds}
                onSelect={onSelect}
                renderItemMenu={renderItemMenu}
              />
            </div>
          )}
        </HoverCardContent>
      </HoverCard>
      {ctx.onAdd ? (
        <button
          type="button"
          onClick={ctx.onAdd}
          aria-label={ctx.addLabel}
          title={ctx.addLabel}
          data-testid={`${ctx.testIdPrefix}-column-add-${ctx.columnId}`}
          className="mb-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
        </button>
      ) : null}
    </>
  )
}

/** Compact clickable item rows inside the hover card. */
function RailItemRows({
  ctx,
  runningIds,
  onSelect,
  renderItemMenu,
}: {
  ctx: RailContext
} & IssueCollapsedRailExtras) {
  return (
    <ul className="flex flex-col">
      {ctx.items.slice(0, PREVIEW_LIMIT).map((item) => {
        const row = (
          <button
            type="button"
            title={item.title}
            onClick={() => onSelect?.(item.unifiedId)}
            data-testid={`rail-item-${item.unifiedId}`}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-accent/60"
          >
            {item.priority !== "none" ? (
              <IssuePriorityIcon priority={item.priority} className="size-3" />
            ) : null}
            {runningIds?.has(item.unifiedId) ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse"
              />
            ) : null}
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {item.identifier}
            </span>
            <span className="min-w-0 truncate text-xs">{item.title}</span>
          </button>
        )
        return <li key={item.unifiedId}>{renderItemMenu?.(item, row) ?? row}</li>
      })}
      {ctx.count > PREVIEW_LIMIT ? (
        <li>
          <button
            type="button"
            onClick={ctx.onExpand}
            aria-label={ctx.expandLabel}
            title={ctx.expandLabel}
            data-testid={`${ctx.testIdPrefix}-column-overflow-${ctx.columnId}`}
            className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            +{ctx.count - PREVIEW_LIMIT}
            <ChevronRightIcon aria-hidden className="size-3" />
          </button>
        </li>
      ) : null}
    </ul>
  )
}
