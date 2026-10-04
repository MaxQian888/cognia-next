"use client"

/**
 * One conversation row's actions, as menu items.
 *
 * Rendered by the desktop `SessionRow` into its hover "⋯" dropdown and its
 * right-click menu, and by the mobile list into its long-press action sheet —
 * each by handing over its primitives (`components/shared/menu-kit.tsx`; the
 * sheet's kit is `components/mobile/shell/session-row-sheet-kit.tsx`). One
 * list, so no surface can offer different things for the same row.
 *
 * The row owns every piece of state an item reads (dialog open flags, the CLI
 * probe, the Codex dispatch spinner) and every handler; this component only
 * decides what is offered and in which order:
 *
 *   selection · rename · pin · read state · branch · continue as project
 *   copy link · export & share
 *   archive · folder · workspace · device handoff · Codex / terminal
 *   delete
 *
 * A conversation mid-handoff (`handoffLock`) keeps the items that do not
 * write it — read state, copy link, export, handoff status — and shows the
 * rest disabled under a one-line explanation, instead of letting each of them
 * fail on click (`assertSessionWritable` refuses them all).
 */

import type { MouseEvent as ReactMouseEvent } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderInputIcon,
  FolderKanbanIcon,
  FolderPlusIcon,
  GitBranchPlusIcon,
  LinkIcon,
  ListChecksIcon,
  LockKeyholeIcon,
  MailIcon,
  MailOpenIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Share2Icon,
  TerminalIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react"

import type { MenuKit } from "@/components/shared/menu-kit"
import { Spinner } from "@/components/ui/spinner"
import { useAppShortcutLabel } from "@/hooks/shortcuts/use-app-shortcut-label"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

export type CogniaAgentStatus = "unknown" | "checking" | "available" | "missing"

export interface SessionRowMenuItemsProps {
  kit: MenuKit
  /** Distinguishes the renders in test ids (`session-row-<surface>-<action>-<id>`). */
  surface: "dropdown" | "context" | "sheet"
  session: ChatSession
  /** Part of the multi-selection — flips Select to Deselect. */
  selected: boolean
  /** Has unread messages — decides Mark as read vs. Mark as unread. */
  unread: boolean
  onToggleSelection?: () => void
  onRename: () => void
  onTogglePinned?: () => void
  onMarkRead?: () => void
  onMarkUnread?: () => void
  onBranch?: () => void
  /** Turn this conversation into a project's first thread (ADR-0204). */
  onContinueAsProject?: () => void
  onCopyLink?: () => void
  onExportShare?: () => void
  onArchive?: () => void
  onUnarchive?: () => void
  /** Folders this conversation may be filed in (workspace-matched already). */
  assignableFolders: readonly SessionFolder[]
  onAssignToFolder?: (folderId: string | null) => void
  /**
   * Make a new folder and file this conversation into it ("Move to folder →
   * New folder…"). Offered only where the new folder could hold the row (it
   * is created in the active workspace); absent, the submenu lists existing
   * folders alone — and with none, filing has nowhere to start from.
   */
  onNewFolder?: () => void
  /** Non-archived workspaces; the current one is shown checked and inert. */
  workspaceTargets: readonly { id: string; name: string }[]
  canMoveWorkspace: boolean
  movingWorkspace: boolean
  onMoveWorkspace: (workspaceId: string) => void
  onHandoff: () => void
  /** Desktop-only CLI / Codex hand-offs; omitted off Tauri. */
  desktop?: {
    codexDispatching: boolean
    onOpenInCodexApp: () => void
    onReturnFromCodexApp?: (event: ReactMouseEvent) => void
    cogniaAgentStatus: CogniaAgentStatus
    onOpenInTerminal: () => void
  }
  onDelete: () => void
}

export function SessionRowMenuItems({
  kit,
  surface,
  session,
  selected,
  unread,
  onToggleSelection,
  onRename,
  onTogglePinned,
  onMarkRead,
  onMarkUnread,
  onBranch,
  onContinueAsProject,
  onCopyLink,
  onExportShare,
  onArchive,
  onUnarchive,
  assignableFolders,
  onAssignToFolder,
  onNewFolder,
  workspaceTargets,
  canMoveWorkspace,
  movingWorkspace,
  onMoveWorkspace,
  onHandoff,
  desktop,
  onDelete,
}: SessionRowMenuItemsProps) {
  const t = useTranslations("desktop.sessionRow")
  const tProject = useTranslations("projectCoordinator.continue")
  const { Item, Label, Separator, Sub, SubTrigger, SubContent, Shortcut } = kit
  const locked = Boolean(session.handoffLock)
  const isArchived = session.archivedAt != null
  const testId = (name: string) => `session-row-${surface}-${name}-${session.id}`
  // An archived row is frozen (ADR-0213): it keeps its pin and folder so a
  // restore puts it back where it was, but neither can change inside the
  // archive, and it carries no unread state (`isBadgeableUnread`) to flip.
  const readStateAction = isArchived ? undefined : unread ? onMarkRead : onMarkUnread
  const archiveShortcut = useAppShortcutLabel("shell.conversation.toggleArchive").label

  return (
    <>
      {locked ? (
        <>
          <Label className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
            <LockKeyholeIcon className="size-3.5 shrink-0 text-amber-600" aria-hidden />
            {t("lockedMenuNote")}
          </Label>
          <Separator />
        </>
      ) : null}
      {onToggleSelection ? (
        <Item onSelect={onToggleSelection} data-testid={testId("select")}>
          <ListChecksIcon className="mr-2 size-4" />
          {selected ? t("deselect") : t("select")}
        </Item>
      ) : null}
      <Item onSelect={onRename} disabled={locked} data-testid={testId("rename")}>
        <PencilIcon className="mr-2 size-4" />
        {t("rename")}
        <Shortcut>F2</Shortcut>
      </Item>
      {onTogglePinned && !isArchived ? (
        <Item onSelect={onTogglePinned} disabled={locked} data-testid={testId("pin")}>
          {session.pinned ? (
            <PinOffIcon className="mr-2 size-4" />
          ) : (
            <PinIcon className="mr-2 size-4" />
          )}
          {session.pinned ? t("unpin") : t("pin")}
        </Item>
      ) : null}
      {readStateAction ? (
        <Item onSelect={readStateAction} data-testid={testId(unread ? "mark-read" : "mark-unread")}>
          {unread ? <MailOpenIcon className="mr-2 size-4" /> : <MailIcon className="mr-2 size-4" />}
          {unread ? t("markRead") : t("markUnread")}
        </Item>
      ) : null}
      {onBranch ? (
        <Item onSelect={onBranch} disabled={locked} data-testid={testId("branch")}>
          <GitBranchPlusIcon className="mr-2 size-4" />
          {t("branch")}
        </Item>
      ) : null}
      {onContinueAsProject ? (
        <Item
          onSelect={onContinueAsProject}
          disabled={locked}
          data-testid={testId("continue-as-project")}
        >
          <WorkflowIcon className="mr-2 size-4" />
          {tProject("menu")}
        </Item>
      ) : null}
      {onCopyLink || onExportShare ? <Separator /> : null}
      {onCopyLink ? (
        <Item onSelect={onCopyLink} data-testid={testId("copy-link")}>
          <LinkIcon className="mr-2 size-4" />
          {t("copyLink")}
        </Item>
      ) : null}
      {onExportShare ? (
        <Item onSelect={onExportShare} data-testid={testId("export")}>
          <Share2Icon className="mr-2 size-4" />
          {t("exportShare")}
        </Item>
      ) : null}
      <Separator />
      {isArchived && onUnarchive ? (
        <Item onSelect={onUnarchive} disabled={locked} data-testid={testId("unarchive")}>
          <ArchiveRestoreIcon className="mr-2 size-4" />
          {t("unarchive")}
          {archiveShortcut ? <Shortcut>{archiveShortcut}</Shortcut> : null}
        </Item>
      ) : null}
      {!isArchived && onArchive ? (
        <Item onSelect={onArchive} disabled={locked} data-testid={testId("archive")}>
          <ArchiveIcon className="mr-2 size-4" />
          {t("archive")}
          {archiveShortcut ? <Shortcut>{archiveShortcut}</Shortcut> : null}
        </Item>
      ) : null}
      {onAssignToFolder &&
      !isArchived &&
      (assignableFolders.length > 0 || session.folderId || onNewFolder) ? (
        <Sub>
          <SubTrigger disabled={locked} data-testid={testId("move-folder")}>
            <FolderInputIcon className="mr-2 size-4" />
            {t("moveToFolder")}
          </SubTrigger>
          <SubContent>
            {assignableFolders.map((folder) => (
              <Item
                key={folder.id}
                onSelect={() => onAssignToFolder(folder.id)}
                aria-current={session.folderId === folder.id ? "true" : undefined}
                data-testid={testId(`folder-${folder.id}`)}
              >
                {session.folderId === folder.id ? (
                  <CheckIcon className="mr-2 size-4" />
                ) : (
                  <FolderIcon className="mr-2 size-4" />
                )}
                <span className="truncate">{folder.name}</span>
              </Item>
            ))}
            {onNewFolder ? (
              <>
                {assignableFolders.length > 0 ? <Separator /> : null}
                <Item onSelect={onNewFolder} data-testid={testId("folder-new")}>
                  <FolderPlusIcon className="mr-2 size-4" />
                  {t("newFolder")}
                </Item>
              </>
            ) : null}
            {session.folderId ? (
              <>
                <Separator />
                <Item onSelect={() => onAssignToFolder(null)} data-testid={testId("folder-none")}>
                  {t("removeFromFolder")}
                </Item>
              </>
            ) : null}
          </SubContent>
        </Sub>
      ) : null}
      {canMoveWorkspace ? (
        <Sub>
          <SubTrigger
            disabled={locked || movingWorkspace}
            data-testid={`session-row-move-workspace-${session.id}`}
          >
            <FolderKanbanIcon className="mr-2 size-4" />
            {t("moveToWorkspace")}
          </SubTrigger>
          <SubContent className="max-h-72 overflow-y-auto">
            {workspaceTargets.map((workspace) => {
              const current = workspace.id === session.projectId
              return (
                <Item
                  key={workspace.id}
                  disabled={current}
                  aria-current={current ? "true" : undefined}
                  onSelect={() => onMoveWorkspace(workspace.id)}
                  data-testid={
                    surface === "dropdown"
                      ? `session-row-workspace-${workspace.id}`
                      : testId(`workspace-${workspace.id}`)
                  }
                >
                  {current ? (
                    <CheckIcon className="mr-2 size-4" />
                  ) : (
                    <FolderIcon className="mr-2 size-4" />
                  )}
                  <span className="truncate">{workspace.name}</span>
                </Item>
              )
            })}
          </SubContent>
        </Sub>
      ) : null}
      <Item onSelect={onHandoff} data-testid={testId("handoff")}>
        <ArrowRightLeftIcon className="mr-2 size-4" />
        {locked ? t("handoffStatus") : t("continueOnDevice")}
      </Item>
      {desktop ? (
        <>
          <Item
            onSelect={desktop.onOpenInCodexApp}
            disabled={desktop.codexDispatching}
            data-testid={testId("codex")}
          >
            {desktop.codexDispatching ? (
              <Spinner className="mr-2 size-4" />
            ) : (
              <ExternalLinkIcon className="mr-2 size-4" />
            )}
            {t("openInCodexApp")}
          </Item>
          {desktop.onReturnFromCodexApp ? (
            <Item
              onClick={desktop.onReturnFromCodexApp}
              disabled={desktop.codexDispatching}
              data-testid={testId("codex-return")}
            >
              <ArrowRightLeftIcon className="mr-2 size-4" />
              {t("returnFromCodexApp")}
            </Item>
          ) : null}
          <Item
            onSelect={desktop.onOpenInTerminal}
            disabled={desktop.cogniaAgentStatus !== "available"}
            title={
              desktop.cogniaAgentStatus === "missing"
                ? t("cogniaAgentNotInstalled")
                : desktop.cogniaAgentStatus !== "available"
                  ? t("cogniaAgentChecking")
                  : undefined
            }
            data-testid={testId("terminal")}
          >
            <TerminalIcon className="mr-2 size-4" />
            {t("openInTerminal")}
          </Item>
        </>
      ) : null}
      <Separator />
      <Item
        onSelect={onDelete}
        disabled={locked}
        className="text-destructive focus:text-destructive"
        data-testid={testId("delete")}
      >
        <Trash2Icon className="mr-2 size-4" />
        {t("delete")}
        <Shortcut>{t("deleteShortcut")}</Shortcut>
      </Item>
    </>
  )
}
