"use client"

/**
 * The action sheet behind a long-press (or the swipe strip's "More") on a
 * mobile conversation row.
 *
 * Its items are the desktop row menu's (`SessionRowMenuItems`), rendered
 * through the sheet kit (`session-row-sheet-kit.tsx`) — one list, so the phone
 * offers exactly what the desktop "⋯" and right-click menus do, in the same
 * order, disabled the same way on a handed-off conversation, minus only the
 * desktop-only terminal / Codex hand-offs and multi-select:
 *
 *   Rename · Pin · Mark read/unread · Branch · Copy link · Export & share ·
 *   Archive · Move to folder · Move to workspace · Continue on another device ·
 *   Delete
 *
 * "Move to folder" and "Move to workspace" open a second page of the sheet
 * instead of a flyout. Every write goes through the list's shared boundary
 * (`useConversationRowActions`); the sheet only decides what is offered.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { SessionRowMenuItems } from "@/components/chat/session-row-menu-items"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import type {
  ConversationRowActions,
  ConversationRowExtraActions,
} from "@/hooks/chat/use-conversation-row-actions"
import { useSessionWorkspaceMoveMenu } from "@/hooks/workspace/use-move-session-workspace"
import { useContinueAsProjectMenu } from "@/hooks/project-coordinator/use-continue-as-project-menu"
import { assignableFolders } from "@/lib/chat/conversation-list-model"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

import { SHEET_MENU_KIT, SessionRowSheetMenu } from "./session-row-sheet-kit"

export interface MobileChannelRowActionsProps {
  /** The conversation the sheet is for; `null` closes it. */
  session: ChatSession | null
  /** Unread messages in it — decides Mark as read vs. Mark as unread. */
  unread: number
  folders: readonly SessionFolder[]
  onClose: () => void
  /** Opens the row's inline rename field. */
  onRename: (session: ChatSession) => void
  onContinueOnDevice: (session: ChatSession) => void
  /** Asks to confirm the delete. */
  onDelete: (session: ChatSession) => void
  /** The list's write boundary — the same one the desktop sidebar uses. */
  rowActions: Pick<
    ConversationRowActions,
    "onTogglePinned" | "onArchive" | "onUnarchive" | "onAssignToFolder"
  >
  extraActions: ConversationRowExtraActions
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
  onContinueOnDevice,
  onDelete,
  rowActions,
  extraActions,
}: MobileChannelRowActionsProps & { session: ChatSession }) {
  const t = useTranslations("mobile.home")
  // Row vocabulary shared with the desktop row menu.
  const tRow = useTranslations("desktop.sessionRow")
  const workspaceMove = useSessionWorkspaceMoveMenu(session)
  const { onContinueAsProject } = useContinueAsProjectMenu(session)
  const title = sessionDisplayTitle(session.title, {
    untitled: tRow("untitled"),
    placeholder: tRow("placeholderTitle"),
  })
  const id = session.id
  const bind = (action: ((id: string) => unknown) | undefined) =>
    action ? () => void action(id) : undefined

  return (
    <>
      <DrawerHeader className="gap-1 pb-2 text-left md:text-left">
        <DrawerTitle className="truncate text-base">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{t("actionsDescription")}</DrawerDescription>
      </DrawerHeader>
      <SessionRowSheetMenu label={title} onPicked={onClose}>
        <SessionRowMenuItems
          kit={SHEET_MENU_KIT}
          surface="sheet"
          session={session}
          selected={false}
          unread={unread > 0}
          onRename={() => onRename(session)}
          onTogglePinned={
            rowActions.onTogglePinned
              ? () => void rowActions.onTogglePinned!(id, !session.pinned)
              : undefined
          }
          onMarkRead={bind(extraActions.onMarkRead)}
          onMarkUnread={bind(extraActions.onMarkUnread)}
          onBranch={bind(extraActions.onBranch)}
          onContinueAsProject={onContinueAsProject}
          onCopyLink={bind(extraActions.onCopyLink)}
          onExportShare={bind(extraActions.onExportShare)}
          onArchive={bind(rowActions.onArchive)}
          onUnarchive={bind(rowActions.onUnarchive)}
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
          onHandoff={() => onContinueOnDevice(session)}
          onDelete={() => onDelete(session)}
        />
      </SessionRowSheetMenu>
    </>
  )
}
