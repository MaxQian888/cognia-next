"use client"

import { useCallback, useMemo, useState } from "react"
import type { SessionFolder } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import {
  trackConversationCreated,
  trackConversationRowAction,
} from "@/lib/telemetry/conversation-list-events"

const log = loggers.ui

interface ChannelListActionCallbacks {
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  onTogglePinned?: (id: string, pinned: boolean) => void | Promise<void>
  onArchive?: (id: string) => void | Promise<void>
  onUnarchive?: (id: string) => void | Promise<void>
  onBulkDelete?: (ids: string[]) => void | Promise<void>
  onBulkSetPinned?: (ids: string[], pinned: boolean) => void | Promise<void>
  onBulkArchive?: (ids: string[]) => void | Promise<void>
  onBulkUnarchive?: (ids: string[]) => void | Promise<void>
  onCreateFolder?: (name: string) => void | Promise<SessionFolder | unknown>
  onReorderFolders?: (ids: string[]) => void | Promise<void>
  onAssignToFolder?: (sessionId: string, folderId: string | null) => void | Promise<void>
}

interface UseChannelListActionsOptions extends ChannelListActionCallbacks {
  folders: readonly SessionFolder[]
  newFolderName: string
}

/**
 * Owns the channel list's user actions and their telemetry/persistence policy.
 * Rendering and list-model derivation stay in ChannelListBody; this hook keeps
 * row, bulk, creation, and folder actions consistent at one boundary.
 */
export function useChannelListActions({
  folders,
  newFolderName,
  onNewDirect,
  onNewTeamConversation,
  onDelete,
  onRename,
  onTogglePinned,
  onArchive,
  onUnarchive,
  onBulkDelete,
  onBulkSetPinned,
  onBulkArchive,
  onBulkUnarchive,
  onCreateFolder,
  onReorderFolders,
  onAssignToFolder,
}: UseChannelListActionsOptions) {
  const handleNewDirect = useCallback(() => {
    log.info("channel-list new-direct")
    void trackConversationCreated("direct")
    onNewDirect()
  }, [onNewDirect])

  const handleNewTeamConversation = useCallback(
    (teamId: string) => {
      log.info("channel-list new-team-conversation", { teamId })
      void trackConversationCreated("team")
      onNewTeamConversation(teamId)
    },
    [onNewTeamConversation]
  )

  const rowActions = useMemo(
    () => ({
      onDelete: (id: string) => {
        void trackConversationRowAction("delete")
        return onDelete(id)
      },
      onRename: (id: string, title: string) => {
        void trackConversationRowAction("rename")
        return onRename(id, title)
      },
      onTogglePinned: onTogglePinned
        ? (id: string, pinned: boolean) => {
            void trackConversationRowAction(pinned ? "pin" : "unpin")
            return onTogglePinned(id, pinned)
          }
        : undefined,
      onArchive: onArchive
        ? (id: string) => {
            void trackConversationRowAction("archive")
            return onArchive(id)
          }
        : undefined,
      onUnarchive: onUnarchive
        ? (id: string) => {
            void trackConversationRowAction("unarchive")
            return onUnarchive(id)
          }
        : undefined,
      onAssignToFolder: onAssignToFolder
        ? (sessionId: string, folderId: string | null) => {
            void trackConversationRowAction(folderId ? "assign-folder" : "unassign-folder")
            return onAssignToFolder(sessionId, folderId)
          }
        : undefined,
      onBulkDelete: onBulkDelete
        ? (ids: string[]) => {
            void trackConversationRowAction("delete", ids.length)
            return onBulkDelete(ids)
          }
        : undefined,
      onBulkSetPinned: onBulkSetPinned
        ? (ids: string[], pinned: boolean) => {
            void trackConversationRowAction(pinned ? "pin" : "unpin", ids.length)
            return onBulkSetPinned(ids, pinned)
          }
        : undefined,
      onBulkArchive: onBulkArchive
        ? (ids: string[]) => {
            void trackConversationRowAction("archive", ids.length)
            return onBulkArchive(ids)
          }
        : undefined,
      onBulkUnarchive: onBulkUnarchive
        ? (ids: string[]) => {
            void trackConversationRowAction("unarchive", ids.length)
            return onBulkUnarchive(ids)
          }
        : undefined,
      onBulkAssignToFolder: onAssignToFolder
        ? async (ids: string[], folderId: string | null) => {
            void trackConversationRowAction(
              folderId ? "assign-folder" : "unassign-folder",
              ids.length
            )
            for (const id of ids) await onAssignToFolder(id, folderId)
          }
        : undefined,
    }),
    [
      onDelete,
      onRename,
      onTogglePinned,
      onArchive,
      onUnarchive,
      onAssignToFolder,
      onBulkDelete,
      onBulkSetPinned,
      onBulkArchive,
      onBulkUnarchive,
    ]
  )

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const handleNewFolder = useCallback(() => {
    if (!onCreateFolder) return
    void Promise.resolve(onCreateFolder(newFolderName))
      .then((created) => {
        const id = (created as SessionFolder | undefined)?.id
        if (id) setRenamingFolderId(id)
      })
      .catch((error: unknown) => {
        log.warn("channel-list create folder failed", { error: String(error) })
      })
  }, [newFolderName, onCreateFolder])
  const handleFolderRenameSettled = useCallback((id: string) => {
    setRenamingFolderId((current) => (current === id ? null : current))
  }, [])

  const orderedFolderIds = useMemo(() => folders.map((folder) => folder.id), [folders])
  const handleMoveFolder = useMemo(
    () =>
      onReorderFolders && orderedFolderIds.length > 1
        ? (id: string, delta: -1 | 1) => {
            const index = orderedFolderIds.indexOf(id)
            const target = index + delta
            if (index < 0 || target < 0 || target >= orderedFolderIds.length) return
            const next = [...orderedFolderIds]
            next.splice(target, 0, ...next.splice(index, 1))
            log.info("channel-list move folder", { delta })
            void Promise.resolve(onReorderFolders(next)).catch((error: unknown) => {
              log.warn("channel-list folder reorder failed", { error: String(error) })
            })
          }
        : undefined,
    [onReorderFolders, orderedFolderIds]
  )

  return {
    handleNewDirect,
    handleNewTeamConversation,
    rowActions,
    renamingFolderId,
    handleNewFolder,
    handleFolderRenameSettled,
    handleMoveFolder,
  }
}
