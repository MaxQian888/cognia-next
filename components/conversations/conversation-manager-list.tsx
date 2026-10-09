"use client"

/**
 * The conversation manager on a phone-width page (`/conversations`, ADR-0213).
 *
 * The table cannot be a phone layout: below ~640px it is a title squeezed to
 * a few characters between a checkbox and a timestamp, with every other fact
 * dropped. This draws the same rows as two-line list items instead —
 *
 *   [avatar]  Refactor the auth middleware 📌                 2 hr ago   ⋯
 *             Coding Assistant · 12 turns · 42K · ◎ Active 4/20
 *
 * — with 44px touch targets, the same row menu (`SessionRowMenuItems`), the
 * same write boundary (`rowActions`) and the same delete confirmation as the
 * table rows.
 *
 * Selection is a mode, not a checkbox column: "Select" in the toolbar (or a
 * long-press on a row) turns the leading avatar into a checkbox and makes a tap
 * toggle instead of open; the shared bulk bar acts on the selection exactly as
 * it does over the table.
 */

import { memo, useRef, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"
import {
  CheckIcon,
  HashIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PinIcon,
  UsersIcon,
} from "lucide-react"

import { ConversationDeleteConfirm } from "@/components/chat/conversation-delete-confirm"
import { SessionRowMenuItems } from "@/components/chat/session-row-menu-items"
import { SessionRunIndicator } from "@/components/chat/session-run-indicator"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import type { RowDecorations } from "@/components/desktop/channel-list/row-decorations"
import { LongPress } from "@/components/interactions/long-press"
import { CountPill } from "@/components/shared/count-pill"
import { DROPDOWN_MENU_KIT } from "@/components/shared/menu-kit"
import { Surface } from "@/components/surface/surface"
import { ThreadHandoffSourceDialog } from "@/components/thread-handoff/thread-handoff-source-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  ConversationRowActions,
  ConversationRowExtraActions,
} from "@/hooks/chat/use-conversation-row-actions"
import type { SessionGoalMap } from "@/hooks/conversations/use-session-goals"
import { useSessionDesktopHandoffs } from "@/hooks/chat/use-session-desktop-handoffs"
import { useContinueAsProjectMenu } from "@/hooks/project-coordinator/use-continue-as-project-menu"
import { useInlineRename } from "@/hooks/ui/use-inline-rename"
import { useSessionWorkspaceMoveMenu } from "@/hooks/workspace/use-move-session-workspace"
import { assignableFolders, conversationLastActivityAt } from "@/lib/chat/conversation-list-model"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { formatTokens } from "@/lib/observability/format-utils"
import type { SessionUsageSummary } from "@/lib/usage/session-analytics"
import { cn } from "@/lib/utils"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { Goal } from "@/types/goal"

import { ConversationGoalChip } from "./conversation-goal-chip"
import type { ConversationRowSelectEvent } from "./conversation-manager-row"

export interface ConversationManagerListProps {
  rows: readonly ChatSession[]
  /** Selection mode: a tap toggles instead of opening. */
  selecting: boolean
  /** A long-press asks for selection mode with this row selected. */
  onStartSelecting: (id: string) => void
  isSelected: (id: string) => boolean
  onToggleSelect: (id: string, event: ConversationRowSelectEvent) => void
  decorations: RowDecorations
  folders: readonly SessionFolder[]
  usage: ReadonlyMap<string, SessionUsageSummary>
  runStatusById: ReadonlyMap<string, ChatStatus>
  unreadCountById: ReadonlyMap<string, number>
  contentOnlyIds: ReadonlySet<string>
  goals: SessionGoalMap
  now: Date
  rowActions: ConversationRowActions
  extraActions: ConversationRowExtraActions
  onOpen: (id: string) => void
}

export function ConversationManagerList({
  rows,
  selecting,
  onStartSelecting,
  isSelected,
  onToggleSelect,
  decorations,
  folders,
  usage,
  runStatusById,
  unreadCountById,
  contentOnlyIds,
  goals,
  now,
  rowActions,
  extraActions,
  onOpen,
}: ConversationManagerListProps) {
  const t = useTranslations("conversations.manager")
  return (
    <div className="px-3 pb-3" data-testid="conversation-list">
      <Surface layer="raised" radius="panel" className="overflow-hidden border">
        <ul aria-label={t("listAria")} className="flex flex-col">
          {rows.map((session) => (
            <ConversationManagerListRow
              key={session.id}
              session={session}
              selecting={selecting}
              selected={isSelected(session.id)}
              onStartSelecting={onStartSelecting}
              onToggleSelect={onToggleSelect}
              decorations={decorations}
              folders={folders}
              usage={usage.get(session.id)}
              runStatus={runStatusById.get(session.id)}
              unread={session.archivedAt != null ? 0 : (unreadCountById.get(session.id) ?? 0)}
              contentMatch={contentOnlyIds.has(session.id)}
              goal={goals.get(session.id)}
              now={now}
              rowActions={rowActions}
              extraActions={extraActions}
              onOpen={onOpen}
            />
          ))}
        </ul>
      </Surface>
    </div>
  )
}

interface ListRowProps {
  session: ChatSession
  selecting: boolean
  selected: boolean
  onStartSelecting: (id: string) => void
  onToggleSelect: (id: string, event: ConversationRowSelectEvent) => void
  decorations: RowDecorations
  folders: readonly SessionFolder[]
  usage: SessionUsageSummary | undefined
  runStatus: ChatStatus | undefined
  unread: number
  contentMatch: boolean
  goal: Goal | undefined
  now: Date
  rowActions: ConversationRowActions
  extraActions: ConversationRowExtraActions
  onOpen: (id: string) => void
}

const ConversationManagerListRow = memo(function ConversationManagerListRow({
  session,
  selecting,
  selected,
  onStartSelecting,
  onToggleSelect,
  decorations,
  folders,
  usage,
  runStatus,
  unread,
  contentMatch,
  goal,
  now,
  rowActions,
  extraActions,
  onOpen,
}: ListRowProps) {
  const t = useTranslations("conversations.manager")
  const tRow = useTranslations("desktop.sessionRow")
  const tRail = useTranslations("desktop.guildRail")
  const format = useFormatter()
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  // The row menu's Rename only marks the request; the field opens once the
  // menu has closed (`onCloseAutoFocus`). Opened while the menu was still up,
  // the menu's focus trap pulled focus back and its return-focus went to the
  // trigger, and either blur committed the untouched field: a cancelled
  // rename before anything could be typed.
  const renameFromMenuRef = useRef(false)
  const [handoffDialogOpen, setHandoffDialogOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const rename = useInlineRename({
    active: editing,
    initial: session.title,
    onCommit: (next) => {
      void rowActions.onRename(session.id, next)
      setEditing(false)
    },
    onCancel: () => setEditing(false),
  })
  const workspaceMove = useSessionWorkspaceMoveMenu(session)
  const continueAsProjectMenu = useContinueAsProjectMenu(session)
  const desktopHandoffs = useSessionDesktopHandoffs(session, (sessionId) => onOpen(sessionId))

  const id = session.id
  const archived = session.archivedAt != null
  const title = sessionDisplayTitle(session.title, {
    untitled: tRow("untitled"),
    placeholder: tRow("placeholderTitle"),
  })
  const icon = decorations.iconFor(session)
  const metadata = decorations.metadataFor(session)
  const agentName =
    metadata.find((item) => item.kind === "agent")?.value ??
    metadata.find((item) => item.kind === "model")?.value
  const KindIcon =
    session.kind === "team" ? UsersIcon : session.characterId ? HashIcon : MessageSquareIcon
  const activityAt = conversationLastActivityAt(session)
  const turns = usage?.turns ?? 0
  const bind = (handler: ((id: string) => void) | undefined) =>
    handler ? () => handler(id) : undefined
  const toggle = () => onToggleSelect(id, { ctrlKey: true, metaKey: false, shiftKey: false })

  return (
    <li
      className={cn(
        "not-last:border-b flex min-w-0 items-center gap-1 pr-1 transition-colors",
        selected && "bg-accent/60"
      )}
      data-conversation-row={id}
      data-testid={`conversation-list-row-${id}`}
      data-state={selected ? "selected" : undefined}
    >
      {editing ? (
        <div className="flex min-h-14 min-w-0 flex-1 items-center py-2 pl-3">
          <Input
            {...rename.inputProps}
            aria-label={tRow("renameInput", { title })}
            className="h-9 text-sm"
            data-testid={`conversation-list-rename-${id}`}
          />
        </div>
      ) : (
        <LongPress
          onLongPress={() => onStartSelecting(id)}
          className="relative flex min-w-0 flex-1"
        >
          {/* The row's tap target, stretched over the whole content area
              (`after:inset-0`). The goal chip on the second line is a link of
              its own, so it sits above this button instead of inside it — a
              link inside a button is not a valid tree. */}
          <button
            type="button"
            onClick={() => (selecting ? toggle() : onOpen(id))}
            aria-label={selecting ? t("rowSelect", { title }) : t("openRow", { title })}
            aria-pressed={selecting ? selected : undefined}
            className="absolute inset-0 z-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 active:bg-muted/50"
            data-testid={`conversation-list-open-${id}`}
          />
          <span className="pointer-events-none relative z-10 flex min-h-14 w-full min-w-0 items-center gap-3 py-2.5 pl-3 [&_a]:pointer-events-auto">
            {selecting ? (
              // Drawn, not a control: the row button is what toggles, and a
              // checkbox (itself a button) inside it would nest buttons.
              <span
                aria-hidden
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-sm border",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background"
                )}
                data-testid={`conversation-list-select-${id}`}
                data-state={selected ? "checked" : "unchecked"}
              >
                {selected ? <CheckIcon className="size-3.5" /> : null}
              </span>
            ) : icon ? (
              <AvatarBadge subject={icon} size={28} textClassName="text-xs" />
            ) : (
              <KindIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-medium">{title}</span>
                {session.pinned ? (
                  <PinIcon
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-label={tRow("pinned")}
                  />
                ) : null}
                <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums">
                  {activityAt > 0 ? format.relativeTime(new Date(activityAt), now) : null}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {goal ? <ConversationGoalChip goal={goal} /> : null}
                {agentName ? <span className="truncate">{agentName}</span> : null}
                {turns > 0 ? (
                  <>
                    {agentName ? <Dot /> : null}
                    <span className="shrink-0 tabular-nums">
                      {t("usageCompact", { turns, tokens: formatTokens(usage?.tokens ?? 0) })}
                    </span>
                  </>
                ) : null}
                {contentMatch ? (
                  <>
                    <Dot />
                    <span className="shrink-0">{t("contentMatch")}</span>
                  </>
                ) : null}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  <SessionRunIndicator
                    status={runStatus ?? "idle"}
                    testIdPrefix={`conversation-list-run-${id}`}
                  />
                  {!archived ? (
                    <CountPill
                      count={unread}
                      srLabel={tRail("unreadCount", { count: unread })}
                      testId={`conversation-list-unread-${id}`}
                    />
                  ) : null}
                </span>
              </span>
            </span>
          </span>
        </LongPress>
      )}
      <DropdownMenu onOpenChange={desktopHandoffs.onActionsOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-11 shrink-0"
            aria-label={t("rowActions", { title })}
            data-testid={`conversation-list-actions-${id}`}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-60"
          onCloseAutoFocus={(event) => {
            if (!renameFromMenuRef.current) return
            renameFromMenuRef.current = false
            event.preventDefault()
            setEditing(true)
          }}
        >
          <SessionRowMenuItems
            kit={DROPDOWN_MENU_KIT}
            surface="dropdown"
            session={session}
            selected={selected}
            unread={unread > 0}
            onToggleSelection={() => {
              if (!selecting) onStartSelecting(id)
              else toggle()
            }}
            // The menu disables Rename on a handed-off (locked) conversation.
            onRename={() => {
              renameFromMenuRef.current = true
            }}
            onTogglePinned={
              rowActions.onTogglePinned
                ? () => void rowActions.onTogglePinned!(id, !session.pinned)
                : undefined
            }
            onMarkRead={bind(extraActions.onMarkRead)}
            onMarkUnread={bind(extraActions.onMarkUnread)}
            onBranch={bind(extraActions.onBranch)}
            onCopyLink={bind(extraActions.onCopyLink)}
            onExportShare={bind(extraActions.onExportShare)}
            onArchive={rowActions.onArchive ? () => void rowActions.onArchive!(id) : undefined}
            onUnarchive={
              rowActions.onUnarchive ? () => void rowActions.onUnarchive!(id) : undefined
            }
            assignableFolders={assignableFolders(session, folders)}
            onAssignToFolder={
              rowActions.onAssignToFolder
                ? (folderId) => {
                    if (folderId !== (session.folderId ?? null)) {
                      void rowActions.onAssignToFolder!(id, folderId)
                    }
                  }
                : undefined
            }
            {...workspaceMove}
            {...continueAsProjectMenu}
            onHandoff={() => setHandoffDialogOpen(true)}
            desktop={desktopHandoffs.desktop}
            onDelete={() => setDeleteConfirmOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <ConversationDeleteConfirm
        session={deleteConfirmOpen ? session : null}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          setDeleteConfirmOpen(false)
          void rowActions.onDelete(id)
        }}
      />
      {handoffDialogOpen ? (
        <ThreadHandoffSourceDialog session={session} open onOpenChange={setHandoffDialogOpen} />
      ) : null}
    </li>
  )
})

function Dot() {
  return <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/60" />
}
