"use client"

/**
 * The action sheet behind a long-press (or the swipe strip's "More") on a
 * mobile conversation row.
 *
 * Before this, pin / archive / delete existed only as swipe gestures and
 * rename only behind an unannounced 500ms hold, so nothing told a user they
 * were there and a screen-reader user could not reach most of them. The sheet
 * is the one place every row action lives — the desktop row menu's set
 * (`session-row.tsx`), minus the desktop-only terminal / Codex handoffs:
 *
 *   Rename · Pin/Unpin · Mark as read · Archive/Unarchive · Move to folder ·
 *   Continue on another device (or its status) · Delete
 *
 * "Move to folder" opens a second page in the same sheet rather than a nested
 * menu, and offers only folders of the conversation's own workspace — the rule
 * the desktop applies, for the same reason: a folder is workspace-scoped, and
 * filing a row into another workspace's folder shows here and is gone after
 * the next workspace switch.
 *
 * A conversation handed off to another device is read-only. Its writes are
 * refused by the session write guard, so the sheet says so up front and
 * disables them instead of letting each one fail.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  CheckCheckIcon,
  CheckIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOutputIcon,
  LockKeyholeIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react"

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { cn } from "@/lib/utils"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

export interface MobileChannelRowActionsProps {
  /** The conversation the sheet is for; `null` closes it. */
  session: ChatSession | null
  /** Unread messages in it — "Mark as read" is offered only above zero. */
  unread: number
  folders: readonly SessionFolder[]
  onClose: () => void
  onRename: (session: ChatSession) => void
  onTogglePin: (session: ChatSession) => void
  onMarkRead: (session: ChatSession) => void
  onToggleArchive: (session: ChatSession) => void
  onMoveToFolder: (session: ChatSession, folderId: string | null) => void
  onContinueOnDevice: (session: ChatSession) => void
  onDelete: (session: ChatSession) => void
}

/**
 * Folders a conversation may be filed into. Both sides are optional (either
 * can predate workspace isolation), so only a known mismatch is dropped.
 */
export function assignableFoldersFor(
  session: Pick<ChatSession, "projectId">,
  folders: readonly SessionFolder[]
): SessionFolder[] {
  return folders.filter(
    (folder) => !folder.projectId || !session.projectId || folder.projectId === session.projectId
  )
}

export function MobileChannelRowActions(props: MobileChannelRowActionsProps) {
  const { session, onClose } = props
  // Keep the last conversation on screen while the sheet animates out;
  // clearing it with the prop would empty the sheet mid-slide.
  const [shown, setShown] = useState<ChatSession | null>(session)
  if (session && session !== shown) setShown(session)
  // Set by the Rename action: the inline field is about to take focus, and the
  // sheet must not hand focus back to the row button it replaced.
  const keepFocusRef = useRef(false)

  return (
    <Drawer
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DrawerContent
        data-testid="mobile-channel-actions"
        // A sideways drag on this sheet is not a request to put the navigation
        // drawer away underneath it (`hooks/ui/use-edge-swipe.ts`).
        data-edge-swipe-ignore=""
        className="pb-[env(safe-area-inset-bottom)]"
        onCloseAutoFocus={(event) => {
          if (!keepFocusRef.current) return
          keepFocusRef.current = false
          event.preventDefault()
        }}
      >
        {shown ? (
          // Keyed by conversation so the folder page never carries over from
          // the previous row.
          <ActionsBody
            key={shown.id}
            {...props}
            session={shown}
            onRename={(target) => {
              keepFocusRef.current = true
              props.onRename(target)
            }}
            onClose={onClose}
          />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

function ActionsBody({
  session,
  unread,
  folders,
  onClose,
  onRename,
  onTogglePin,
  onMarkRead,
  onToggleArchive,
  onMoveToFolder,
  onContinueOnDevice,
  onDelete,
}: MobileChannelRowActionsProps & { session: ChatSession }) {
  const t = useTranslations("mobile.home")
  // Row vocabulary shared with the desktop row menu.
  const tRow = useTranslations("desktop.sessionRow")
  const tCommon = useTranslations("common")
  const [page, setPage] = useState<"main" | "folders">("main")

  const locked = session.handoffLock != null
  const archived = session.archivedAt != null
  const assignable = assignableFoldersFor(session, folders)
  const canMove = assignable.length > 0 || session.folderId != null
  const title = session.title || tRow("untitled")

  /** Close first, then act: the action may open the next surface. */
  const run = (action: (target: ChatSession) => void) => () => {
    onClose()
    action(session)
  }

  return (
    <>
      <DrawerHeader className="gap-1 pb-2 text-left md:text-left">
        <DrawerTitle className="truncate text-base">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{t("actionsDescription")}</DrawerDescription>
      </DrawerHeader>
      {locked ? (
        <p
          className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          role="note"
          data-testid="mobile-channel-actions-locked"
        >
          <LockKeyholeIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <span>{t("actionLocked")}</span>
        </p>
      ) : null}
      {page === "main" ? (
        <div className="flex flex-col px-2 pb-3" role="group" aria-label={title}>
          <ActionItem
            icon={PencilIcon}
            label={tRow("rename")}
            disabled={locked}
            onSelect={run(onRename)}
            testId="mobile-channel-action-rename"
          />
          <ActionItem
            icon={session.pinned ? PinOffIcon : PinIcon}
            label={session.pinned ? tRow("unpin") : tRow("pin")}
            disabled={locked}
            onSelect={run(onTogglePin)}
            testId="mobile-channel-action-pin"
          />
          {unread > 0 ? (
            <ActionItem
              icon={CheckCheckIcon}
              label={t("markRead")}
              onSelect={run(onMarkRead)}
              testId="mobile-channel-action-mark-read"
            />
          ) : null}
          <ActionItem
            icon={archived ? ArchiveRestoreIcon : ArchiveIcon}
            label={archived ? tRow("unarchive") : tRow("archive")}
            disabled={locked}
            onSelect={run(onToggleArchive)}
            testId="mobile-channel-action-archive"
          />
          {canMove ? (
            <ActionItem
              icon={FolderInputIcon}
              label={tRow("moveToFolder")}
              disabled={locked}
              onSelect={() => setPage("folders")}
              testId="mobile-channel-action-move"
            />
          ) : null}
          <ActionItem
            icon={ArrowRightLeftIcon}
            label={locked ? tRow("handoffStatus") : tRow("continueOnDevice")}
            onSelect={run(onContinueOnDevice)}
            testId="mobile-channel-action-handoff"
          />
          <ActionItem
            icon={Trash2Icon}
            label={tRow("delete")}
            destructive
            disabled={locked}
            onSelect={run(onDelete)}
            testId="mobile-channel-action-delete"
          />
        </div>
      ) : (
        <div className="flex flex-col px-2 pb-3" role="group" aria-label={tRow("moveToFolder")}>
          <ActionItem
            icon={ArrowLeftIcon}
            label={tCommon("back")}
            onSelect={() => setPage("main")}
            testId="mobile-channel-action-folders-back"
          />
          <div className="max-h-[50vh] overflow-y-auto">
            {assignable.map((folder) => (
              <ActionItem
                key={folder.id}
                icon={session.folderId === folder.id ? CheckIcon : FolderIcon}
                label={folder.name}
                checked={session.folderId === folder.id}
                onSelect={() => {
                  onClose()
                  // Re-filing into the folder it is already in is a no-op.
                  if (session.folderId !== folder.id) onMoveToFolder(session, folder.id)
                }}
                testId={`mobile-channel-action-folder-${folder.id}`}
              />
            ))}
          </div>
          {session.folderId ? (
            <ActionItem
              icon={FolderOutputIcon}
              label={tRow("removeFromFolder")}
              onSelect={() => {
                onClose()
                onMoveToFolder(session, null)
              }}
              testId="mobile-channel-action-folder-remove"
            />
          ) : null}
        </div>
      )}
    </>
  )
}

function ActionItem({
  icon: Icon,
  label,
  onSelect,
  disabled = false,
  destructive = false,
  checked,
  testId,
}: {
  icon: LucideIcon
  label: string
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
  /** Set for a choice in a list (the folder page), where the current one is marked. */
  checked?: boolean
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-current={checked ? "true" : undefined}
      data-testid={testId}
      className={cn(
        "flex min-h-12 w-full min-w-0 items-center gap-3 rounded-md px-3 text-left text-base outline-none",
        "active:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-fine:hover:bg-accent/60",
        "disabled:pointer-events-none disabled:opacity-50",
        destructive && "text-destructive"
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
