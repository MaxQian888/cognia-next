"use client"

/**
 * One conversation row's actions, as menu items.
 *
 * Rendered twice by `SessionRow` — into the hover "⋯" dropdown and into the
 * row's right-click menu — by handing over the matching primitives (the
 * `workflow-action-items.tsx` pattern). One list, so the two menus can never
 * offer different things for the same row.
 *
 * The row owns every piece of state an item reads (dialog open flags, the CLI
 * probe, the Codex dispatch spinner) and every handler; this component only
 * decides what is offered and in which order:
 *
 *   selection · rename · pin · read state · branch
 *   copy link · export & share
 *   archive · folder · workspace · device handoff · Codex / terminal
 *   delete
 *
 * A conversation mid-handoff (`handoffLock`) keeps the items that do not
 * write it — read state, copy link, export, handoff status — and shows the
 * rest disabled under a one-line explanation, instead of letting each of them
 * fail on click (`assertSessionWritable` refuses them all).
 */

import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode } from "react"
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
} from "lucide-react"

import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

interface KitItemProps {
  children?: ReactNode
  disabled?: boolean
  className?: string
  title?: string
  onSelect?: (event: Event) => void
  onClick?: (event: ReactMouseEvent) => void
  "data-testid"?: string
}

/** The primitives both Radix menus share — an item list renders into either. */
export interface SessionRowMenuKit {
  Item: ComponentType<KitItemProps>
  Label: ComponentType<{ children?: ReactNode; className?: string }>
  Separator: ComponentType
  Sub: ComponentType<{ children?: ReactNode }>
  SubTrigger: ComponentType<{
    children?: ReactNode
    disabled?: boolean
    "data-testid"?: string
  }>
  SubContent: ComponentType<{ children?: ReactNode; className?: string }>
}

export const DROPDOWN_MENU_KIT: SessionRowMenuKit = {
  Item: DropdownMenuItem as ComponentType<KitItemProps>,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
}

export const CONTEXT_MENU_KIT: SessionRowMenuKit = {
  Item: ContextMenuItem as ComponentType<KitItemProps>,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
}

export type CogniaAgentStatus = "unknown" | "checking" | "available" | "missing"

export interface SessionRowMenuItemsProps {
  kit: SessionRowMenuKit
  /** Distinguishes the two renders in test ids (`…-menu-dropdown-…`). */
  surface: "dropdown" | "context"
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
  onCopyLink?: () => void
  onExportShare?: () => void
  onArchive?: () => void
  onUnarchive?: () => void
  /** Folders this conversation may be filed in (workspace-matched already). */
  assignableFolders: readonly SessionFolder[]
  onAssignToFolder?: (folderId: string | null) => void
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
  onCopyLink,
  onExportShare,
  onArchive,
  onUnarchive,
  assignableFolders,
  onAssignToFolder,
  workspaceTargets,
  canMoveWorkspace,
  movingWorkspace,
  onMoveWorkspace,
  onHandoff,
  desktop,
  onDelete,
}: SessionRowMenuItemsProps) {
  const t = useTranslations("desktop.sessionRow")
  const { Item, Label, Separator, Sub, SubTrigger, SubContent } = kit
  const locked = Boolean(session.handoffLock)
  const isArchived = session.archivedAt != null
  const testId = (name: string) => `session-row-${surface}-${name}-${session.id}`
  const readStateAction = unread ? onMarkRead : onMarkUnread

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
        <MenuShortcut>F2</MenuShortcut>
      </Item>
      {onTogglePinned ? (
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
        </Item>
      ) : null}
      {!isArchived && onArchive ? (
        <Item onSelect={onArchive} disabled={locked} data-testid={testId("archive")}>
          <ArchiveIcon className="mr-2 size-4" />
          {t("archive")}
        </Item>
      ) : null}
      {onAssignToFolder && (assignableFolders.length > 0 || session.folderId) ? (
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
        <MenuShortcut>{t("deleteShortcut")}</MenuShortcut>
      </Item>
    </>
  )
}

/** Trailing key hint, the way both Radix menus' own `*Shortcut` parts draw it. */
function MenuShortcut({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto pl-4 text-xs tracking-widest text-muted-foreground" aria-hidden>
      {children}
    </span>
  )
}
