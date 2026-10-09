"use client"

/**
 * The conversation manager's table: one row per conversation, sortable by the
 * columns the shared list model can order by, with a select-all checkbox that
 * means every conversation the view holds — not only the page drawn.
 *
 * Columns give way to the title as the page narrows (container queries on
 * `@container/conversations`), and each one arrives only once the title still
 * has ~20rem beside it: the agent at `@2xl`, usage (turns · tokens · cost in
 * one cell, where three thin columns used to sit) at `@4xl`, the creation date
 * at `@5xl`, and the workspace at `@6xl` — and only when the rows actually
 * span more than one workspace, since a column repeating "Default" on every
 * row says nothing. The title, the last activity and the row's menu always
 * stay. At 900px the old order showed five metadata columns and cut titles to
 * "Refac…".
 *
 * While a search query ranks the rows by relevance, the headers say so rather
 * than claim the order they would sort by.
 */

import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon } from "lucide-react"
import type { ChatSession, ConversationSortBy, SessionFolder } from "@cognia/agent-config-types"

import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { RowDecorations } from "@/components/desktop/channel-list/row-decorations"
import type {
  ConversationRowActions,
  ConversationRowExtraActions,
} from "@/hooks/chat/use-conversation-row-actions"
import {
  ariaSortForColumn,
  sortForColumn,
  type ConversationManagerSortColumn,
} from "@/lib/conversations/conversation-manager"
import type { SessionUsageSummary } from "@/lib/usage/session-analytics"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { SessionGoalMap } from "@/hooks/conversations/use-session-goals"
import { cn } from "@/lib/utils"

import { ConversationManagerRow, type ConversationRowSelectEvent } from "./conversation-manager-row"

export interface ConversationManagerTableProps {
  /** The rows drawn (one page of the view, in order). */
  rows: readonly ChatSession[]
  /** How many rows the view holds — what select-all selects. */
  totalInView: number
  selectedCount: number
  isSelected: (id: string) => boolean
  onToggleSelect: (id: string, event: ConversationRowSelectEvent) => void
  onSelectAll: () => void
  onClearSelection: () => void
  sortBy: ConversationSortBy
  onSortBy: (sortBy: ConversationSortBy) => void
  /** A search query is ordering the rows by relevance; the sort only breaks ties. */
  ranked: boolean
  /** The rows span more than one workspace, so the workspace column says something. */
  showWorkspace: boolean
  /** The goal each drawn conversation runs (or last ran). */
  goals: SessionGoalMap
  decorations: RowDecorations
  workspaceNameById: ReadonlyMap<string, string>
  folders: readonly SessionFolder[]
  usage: ReadonlyMap<string, SessionUsageSummary>
  runStatusById: ReadonlyMap<string, ChatStatus>
  /** Unread messages per conversation (archived rows show none). */
  unreadCountById: ReadonlyMap<string, number>
  contentOnlyIds: ReadonlySet<string>
  now: Date
  rowActions: ConversationRowActions
  extraActions: ConversationRowExtraActions
  onOpen: (id: string) => void
}

export function ConversationManagerTable({
  rows,
  totalInView,
  selectedCount,
  isSelected,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  sortBy,
  onSortBy,
  ranked,
  showWorkspace,
  goals,
  decorations,
  workspaceNameById,
  folders,
  usage,
  runStatusById,
  unreadCountById,
  contentOnlyIds,
  now,
  rowActions,
  extraActions,
  onOpen,
}: ConversationManagerTableProps) {
  const t = useTranslations("conversations.manager")
  const allSelected = totalInView > 0 && selectedCount >= totalInView
  const someSelected = selectedCount > 0 && !allSelected

  const sortHeader = (column: ConversationManagerSortColumn, label: string, className?: string) => {
    const direction = ariaSortForColumn(sortBy, column, ranked)
    const Arrow =
      direction === "ascending"
        ? ArrowUpIcon
        : direction === "descending"
          ? ArrowDownIcon
          : ArrowUpDownIcon
    return (
      <TableHead aria-sort={direction} className={className}>
        <button
          type="button"
          onClick={() => onSortBy(sortForColumn(sortBy, column))}
          aria-label={t("sortBy", { column: label })}
          title={ranked ? t("rankedHint") : undefined}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
            direction !== "none" && "text-foreground"
          )}
          data-testid={`conversation-table-sort-${column}`}
        >
          {label}
          <Arrow className={cn("size-3", direction === "none" && "opacity-40")} aria-hidden />
        </button>
      </TableHead>
    )
  }

  return (
    <div className="@container/conversations" data-testid="conversation-table">
      <Table className="table-fixed">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-10 pr-0">
              <Checkbox
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                onCheckedChange={() => (allSelected ? onClearSelection() : onSelectAll())}
                disabled={totalInView === 0}
                aria-label={t("columns.selectAll")}
                data-testid="conversation-table-select-all"
              />
            </TableHead>
            {sortHeader("title", t("columns.title"), "w-auto")}
            <TableHead className="hidden w-40 @2xl/conversations:table-cell">
              {t("columns.agent")}
            </TableHead>
            {showWorkspace ? (
              <TableHead className="hidden w-36 @6xl/conversations:table-cell">
                {t("columns.workspace")}
              </TableHead>
            ) : null}
            {sortHeader("activity", t("columns.activity"), "w-28")}
            {sortHeader(
              "created",
              t("columns.created"),
              "hidden w-28 @5xl/conversations:table-cell"
            )}
            <TableHead className="hidden w-40 text-right @4xl/conversations:table-cell">
              {t("columns.usage")}
            </TableHead>
            <TableHead className="w-10">
              <span className="sr-only">{t("columns.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((session) => (
            <ConversationManagerRow
              key={session.id}
              session={session}
              selected={isSelected(session.id)}
              onToggleSelect={onToggleSelect}
              decorations={decorations}
              workspaceName={
                session.projectId ? workspaceNameById.get(session.projectId) : undefined
              }
              showWorkspace={showWorkspace}
              goal={goals.get(session.id)}
              folders={folders}
              usage={usage.get(session.id)}
              runStatus={runStatusById.get(session.id)}
              unread={session.archivedAt != null ? 0 : (unreadCountById.get(session.id) ?? 0)}
              contentMatch={contentOnlyIds.has(session.id)}
              now={now}
              rowActions={rowActions}
              extraActions={extraActions}
              onOpen={onOpen}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
