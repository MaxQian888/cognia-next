"use client"

/**
 * One conversation in the conversation manager's table (`/conversations`).
 *
 * A table row, not a sidebar row, but the same conversation: its ⋯ menu is the
 * row menu every conversation list uses (`SessionRowMenuItems`, with the
 * desktop hand-offs from `useSessionDesktopHandoffs`), the rename is the shared
 * inline field (`useInlineRename`: IME-safe Enter, one settle, Escape kept),
 * the delete goes through `ConversationDeleteConfirm`, and every write goes
 * through the list's write boundary (`useConversationRowActions`).
 *
 * The facts a sidebar shows as places are facts here: a pin is a glyph beside
 * the title, a folder is a chip — in the archive both are frozen (ADR-0213)
 * and still shown, because they are where the row returns to on restore. The
 * facts line under the title only renders when there is a fact to put on it,
 * so a plain row stays one line instead of carrying an empty second one. A
 * conversation running a goal says so with a chip that opens the goal.
 */

import { memo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { useFormatter, useTranslations } from "next-intl"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"
import {
  FolderIcon,
  HashIcon,
  LockKeyholeIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  MoreHorizontalIcon,
  PinIcon,
  UsersIcon,
} from "lucide-react"

import { ConversationDeleteConfirm } from "@/components/chat/conversation-delete-confirm"
import { SessionRowMenuItems } from "@/components/chat/session-row-menu-items"
import { SessionRunIndicator } from "@/components/chat/session-run-indicator"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import type { RowDecorations } from "@/components/desktop/channel-list/row-decorations"
import { CountPill } from "@/components/shared/count-pill"
import { DROPDOWN_MENU_KIT } from "@/components/shared/menu-kit"
import { ThreadHandoffSourceDialog } from "@/components/thread-handoff/thread-handoff-source-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import type {
  ConversationRowActions,
  ConversationRowExtraActions,
} from "@/hooks/chat/use-conversation-row-actions"
import { useSessionDesktopHandoffs } from "@/hooks/chat/use-session-desktop-handoffs"
import { useContinueAsProjectMenu } from "@/hooks/project-coordinator/use-continue-as-project-menu"
import { useAppShortcutLabel } from "@/hooks/shortcuts/use-app-shortcut-label"
import { useInlineRename } from "@/hooks/ui/use-inline-rename"
import { useSessionWorkspaceMoveMenu } from "@/hooks/workspace/use-move-session-workspace"
import { assignableFolders, conversationLastActivityAt } from "@/lib/chat/conversation-list-model"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { formatTokens } from "@/lib/observability/format-utils"
import { formatBucketCost, type SessionUsageSummary } from "@/lib/usage/session-analytics"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { Goal } from "@/types/goal"

import { ConversationGoalChip } from "./conversation-goal-chip"

/** Selection click, with the modifiers a range selection reads. */
export interface ConversationRowSelectEvent {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export interface ConversationManagerRowProps {
  session: ChatSession
  selected: boolean
  onToggleSelect: (id: string, event: ConversationRowSelectEvent) => void
  decorations: RowDecorations
  workspaceName: string | undefined
  /** Render the workspace cell (the table shows the column). */
  showWorkspace: boolean
  /** The goal this conversation runs, or last ran. */
  goal?: Goal
  /** Folders of the profile; the menu offers those that can hold this row. */
  folders: readonly SessionFolder[]
  usage: SessionUsageSummary | undefined
  runStatus: ChatStatus | undefined
  /** Unread messages; 0 for an archived row, which carries no unread state. */
  unread: number
  /** The row surfaced only because its message content matched the search. */
  contentMatch: boolean
  /** The list's clock, for relative times. */
  now: Date
  rowActions: ConversationRowActions
  extraActions: ConversationRowExtraActions
  onOpen: (id: string) => void
}

function ConversationManagerRowImpl({
  session,
  selected,
  onToggleSelect,
  decorations,
  workspaceName,
  showWorkspace,
  goal,
  folders,
  usage,
  runStatus,
  unread,
  contentMatch,
  now,
  rowActions,
  extraActions,
  onOpen,
}: ConversationManagerRowProps) {
  const t = useTranslations("conversations.manager")
  const tRow = useTranslations("desktop.sessionRow")
  const tRail = useTranslations("desktop.guildRail")
  const format = useFormatter()
  const archiveShortcutAria = useAppShortcutLabel("shell.conversation.toggleArchive").aria
  const [editing, setEditing] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  // The row menu's Rename only marks the request; the field opens once the
  // menu has closed (`onCloseAutoFocus`). Opened while the menu was still up,
  // the menu's focus trap pulled focus back and its return-focus went to the
  // trigger, and either blur committed the untouched field: a cancelled
  // rename before anything could be typed.
  const renameFromMenuRef = useRef(false)
  const [handoffDialogOpen, setHandoffDialogOpen] = useState(false)

  const id = session.id
  const locked = Boolean(session.handoffLock)
  const archived = session.archivedAt != null
  const title = sessionDisplayTitle(session.title, {
    untitled: tRow("untitled"),
    placeholder: tRow("placeholderTitle"),
  })
  const rename = useInlineRename({
    active: editing,
    initial: session.title,
    onCommit: (next) => {
      void rowActions.onRename(id, next)
      setEditing(false)
    },
    onCancel: () => setEditing(false),
  })
  const startRename = () => {
    // Renaming a handed-off conversation would only fail at commit time.
    if (!locked) setEditing(true)
  }

  const workspaceMove = useSessionWorkspaceMoveMenu(session)
  const continueAsProjectMenu = useContinueAsProjectMenu(session)
  const desktopHandoffs = useSessionDesktopHandoffs(session, (sessionId) => onOpen(sessionId))
  const folderName = session.folderId
    ? folders.find((folder) => folder.id === session.folderId)?.name
    : undefined
  const icon = decorations.iconFor(session)
  const metadata = decorations.metadataFor(session)
  const agentName = metadata.find((item) => item.kind === "agent")?.value
  const modelName = metadata.find((item) => item.kind === "model")?.value
  const KindIcon =
    session.kind === "team" ? UsersIcon : session.characterId ? HashIcon : MessageSquareIcon
  const activityAt = conversationLastActivityAt(session)
  const turns = usage?.turns ?? 0
  const hasFacts =
    Boolean(goal) ||
    Boolean(folderName) ||
    locked ||
    contentMatch ||
    (runStatus !== undefined && runStatus !== "idle") ||
    (!archived && unread > 0)

  const bind = (handler: ((id: string) => void) | undefined) =>
    handler ? () => handler(id) : undefined

  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      data-testid={`conversation-row-${id}`}
      // On the row, not the title button: the page's archive chord reads the
      // focused row, and focus is as often on the checkbox or the ⋯ button.
      data-conversation-row={id}
      className="group"
    >
      <TableCell className="w-10 pr-0">
        <Checkbox
          checked={selected}
          aria-label={t("rowSelect", { title })}
          onClick={(event: ReactMouseEvent) => {
            // Checkbox semantics — toggle, and Shift extends from the last
            // one — so the click reads as a modified click on the range.
            event.preventDefault()
            onToggleSelect(id, { ctrlKey: true, metaKey: false, shiftKey: event.shiftKey })
          }}
          data-testid={`conversation-row-select-${id}`}
        />
      </TableCell>
      <TableCell className="max-w-0 min-w-56">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? (
            <AvatarBadge subject={icon} size={20} textClassName="text-[10px]" />
          ) : (
            <KindIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input
                {...rename.inputProps}
                aria-label={tRow("renameInput", { title })}
                className="h-7 px-1.5 py-0 text-sm"
                data-testid={`conversation-row-rename-${id}`}
              />
            ) : (
              <button
                type="button"
                onClick={() => onOpen(id)}
                onDoubleClick={startRename}
                onKeyDown={(event) => {
                  // The keys the row menu advertises, as the sidebar row reads
                  // them; the archive chord is the page's (`ConversationManager`).
                  if (event.altKey || event.ctrlKey) return
                  if (event.key === "F2" && !event.metaKey && !event.shiftKey) {
                    event.preventDefault()
                    startRename()
                    return
                  }
                  const deleteChord =
                    (event.key === "Delete" && !event.metaKey && !event.shiftKey) ||
                    (event.key === "Backspace" && event.metaKey && !event.shiftKey)
                  if (deleteChord) {
                    event.preventDefault()
                    if (!locked) setDeleteConfirmOpen(true)
                  }
                }}
                aria-label={t("openRow", { title })}
                aria-keyshortcuts={
                  archiveShortcutAria ? `F2 Delete ${archiveShortcutAria}` : "F2 Delete"
                }
                className="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                data-testid={`conversation-row-open-${id}`}
              >
                <span className="truncate">{title}</span>
                {session.pinned ? (
                  <PinIcon
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-label={tRow("pinned")}
                  />
                ) : null}
              </button>
            )}
            {hasFacts ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {goal ? <ConversationGoalChip goal={goal} /> : null}
                {folderName ? (
                  <span
                    className="inline-flex min-w-0 items-center gap-1 rounded-sm bg-muted/60 px-1"
                    data-testid={`conversation-row-folder-${id}`}
                  >
                    <FolderIcon className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{t("inFolder", { name: folderName })}</span>
                  </span>
                ) : null}
                {locked ? (
                  <LockKeyholeIcon
                    className="size-3 shrink-0 text-amber-600"
                    aria-label={tRow("handoffReadonly")}
                  />
                ) : null}
                {contentMatch ? (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <MessageSquareTextIcon className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{t("contentMatch")}</span>
                  </span>
                ) : null}
                <SessionRunIndicator
                  status={runStatus ?? "idle"}
                  testIdPrefix={`conversation-row-run-${id}`}
                />
                {!archived ? (
                  <CountPill
                    count={unread}
                    srLabel={tRail("unreadCount", { count: unread })}
                    testId={`conversation-row-unread-${id}`}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden max-w-0 text-xs @2xl/conversations:table-cell">
        {/* A conversation with no agent is named by its model alone, not by a
            dash with the model under it. */}
        <span className="block truncate">{agentName ?? modelName ?? t("none")}</span>
        {agentName && modelName ? (
          <span className="block truncate text-[11px] text-muted-foreground">{modelName}</span>
        ) : null}
      </TableCell>
      {showWorkspace ? (
        <TableCell className="hidden max-w-0 text-xs text-muted-foreground @6xl/conversations:table-cell">
          <span className="block truncate">{workspaceName ?? t("noWorkspace")}</span>
        </TableCell>
      ) : null}
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
        {activityAt > 0 ? (
          <time
            dateTime={new Date(activityAt).toISOString()}
            title={format.dateTime(new Date(activityAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          >
            {format.relativeTime(new Date(activityAt), now)}
          </time>
        ) : (
          t("none")
        )}
      </TableCell>
      <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground @5xl/conversations:table-cell">
        {session.createdAt ? (
          <time dateTime={new Date(session.createdAt).toISOString()}>
            {format.dateTime(new Date(session.createdAt), { dateStyle: "medium" })}
          </time>
        ) : (
          t("none")
        )}
      </TableCell>
      <TableCell
        className="hidden text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground @4xl/conversations:table-cell"
        data-testid={`conversation-row-usage-${id}`}
      >
        {usage && turns > 0
          ? t("usage", {
              turns,
              tokens: formatTokens(usage.tokens ?? 0),
              cost: formatBucketCost(usage.costUsd, usage.unpricedTurns, turns),
            })
          : t("none")}
      </TableCell>
      <TableCell className="w-10 text-right">
        <DropdownMenu onOpenChange={desktopHandoffs.onActionsOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("rowActions", { title })}
              data-testid={`conversation-row-actions-${id}`}
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
              startRename()
            }}
          >
            <SessionRowMenuItems
              kit={DROPDOWN_MENU_KIT}
              surface="dropdown"
              session={session}
              selected={selected}
              unread={unread > 0}
              onToggleSelection={() =>
                onToggleSelect(id, { ctrlKey: true, metaKey: false, shiftKey: false })
              }
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
                      // Re-filing into the folder it is already in is a no-op.
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
        {/* Mounted only while open: the dialog prepares a hand-off ticket. */}
        {handoffDialogOpen ? (
          <ThreadHandoffSourceDialog session={session} open onOpenChange={setHandoffDialogOpen} />
        ) : null}
      </TableCell>
    </TableRow>
  )
}

export const ConversationManagerRow = memo(ConversationManagerRowImpl)
