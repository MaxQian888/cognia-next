"use client"

/**
 * The conversation manager's table: one row per conversation, sortable by the
 * columns the shared list model can order by, with a select-all checkbox that
 * means every conversation the view holds — not only the page drawn.
 *
 * Columns give way to the title as the page narrows (container queries on
 * `@container/conversations`): cost, then turns and tokens, then the agent,
 * the workspace and the creation date; the title, the last activity and the
 * row's menu always stay.
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
    const direction = ariaSortForColumn(sortBy, column)
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
            <TableHead className="hidden w-36 @3xl/conversations:table-cell">
              {t("columns.workspace")}
            </TableHead>
            <TableHead className="hidden w-40 @2xl/conversations:table-cell">
              {t("columns.agent")}
            </TableHead>
            {sortHeader("activity", t("columns.activity"), "w-32")}
            {sortHeader(
              "created",
              t("columns.created"),
              "hidden w-32 @4xl/conversations:table-cell"
            )}
            <TableHead className="hidden w-16 text-right @xl/conversations:table-cell">
              {t("columns.turns")}
            </TableHead>
            <TableHead className="hidden w-20 text-right @xl/conversations:table-cell">
              {t("columns.tokens")}
            </TableHead>
            <TableHead className="hidden w-24 text-right @lg/conversations:table-cell">
              {t("columns.cost")}
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
