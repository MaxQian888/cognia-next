"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SessionFolder } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import {
  useConversationRowActions,
  type UseConversationRowActionsOptions,
} from "@/hooks/chat/use-conversation-row-actions"
import { useSessionWrite } from "@/hooks/chat/use-session-write"
import { trackConversationCreated } from "@/lib/telemetry/conversation-list-events"

const log = loggers.ui

interface UseChannelListActionsOptions extends UseConversationRowActionsOptions {
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
  onCreateFolder?: (name: string) => void | Promise<SessionFolder | unknown>
  onReorderFolders?: (ids: string[]) => void | Promise<unknown>
  folders: readonly SessionFolder[]
  newFolderName: string
}

/**
 * The desktop sidebar's actions: every row and bulk write through the shared
 * list boundary (`useConversationRowActions` — the mobile drawer uses the same
 * one), plus what only this list offers — starting a conversation, creating a
 * folder (then renaming it in place) and moving folders up and down.
 *
 * Every returned handler is stable across renders while the set of available
 * owner callbacks stays the same: the rows are memoized on them.
 */
export function useChannelListActions(options: UseChannelListActionsOptions) {
  const { folders } = options
  const rowBundle = useConversationRowActions(options)
  const runWrite = useSessionWrite()

  const latest = useRef({ options })
  useEffect(() => {
    latest.current = { options }
  })

  const handleNewDirect = useCallback(() => {
    log.info("channel-list new-direct")
    void trackConversationCreated("direct")
    latest.current.options.onNewDirect()
  }, [])

  const handleNewTeamConversation = useCallback((teamId: string) => {
    log.info("channel-list new-team-conversation", { teamId })
    void trackConversationCreated("team")
    latest.current.options.onNewTeamConversation(teamId)
  }, [])

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const handleNewFolder = useCallback(() => {
    const { onCreateFolder } = latest.current.options
    if (!onCreateFolder) return
    let created: unknown
    void runWrite("folderCreate", [], async () => {
      created = await onCreateFolder(latest.current.options.newFolderName)
    }).then((ok) => {
      const id = ok ? (created as SessionFolder | undefined)?.id : undefined
      if (id) setRenamingFolderId(id)
    })
  }, [runWrite])
  const handleFolderRenameSettled = useCallback((id: string) => {
    setRenamingFolderId((current) => (current === id ? null : current))
  }, [])

  // "Move to folder → New folder…": the folder is made for these rows, so it is
  // created, they are filed into it, and only then does its name open for
  // editing — the same in-place rename a folder made from the ⋯ menu gets. One
  // trip instead of three (make a folder, name it, come back and file the
  // rows). Resolves `false` when either write was refused or failed, so a bulk
  // selection survives for a retry.
  const { onBulkAssignToFolder } = rowBundle.rowActions
  const canCreateFolder = Boolean(options.onCreateFolder)
  const handleNewFolderWith = useMemo(
    () =>
      canCreateFolder && onBulkAssignToFolder
        ? async (ids: readonly string[]): Promise<boolean> => {
            const { onCreateFolder } = latest.current.options
            if (!onCreateFolder || ids.length === 0) return false
            let created: unknown
            const ok = await runWrite("folderCreate", [], async () => {
              created = await onCreateFolder(latest.current.options.newFolderName)
            })
            const id = ok ? (created as SessionFolder | undefined)?.id : undefined
            if (!id) return false
            log.info("channel-list new folder from rows", { count: ids.length })
            // Asked to be named as soon as it exists — and either way: a folder
            // left under its placeholder name is exactly what this path exists
            // to avoid. The rows file in while the name is being typed.
            setRenamingFolderId(id)
            const moved = await onBulkAssignToFolder([...ids], id)
            return moved !== false
          }
        : undefined,
    [canCreateFolder, onBulkAssignToFolder, runWrite]
  )

  const orderedFolderIds = useMemo(() => folders.map((folder) => folder.id), [folders])
  const hasReorderFolders = Boolean(options.onReorderFolders)
  const handleMoveFolder = useMemo(
    () =>
      hasReorderFolders && orderedFolderIds.length > 1
        ? (id: string, delta: -1 | 1) => {
            const index = orderedFolderIds.indexOf(id)
            const target = index + delta
            if (index < 0 || target < 0 || target >= orderedFolderIds.length) return
            const next = [...orderedFolderIds]
            next.splice(target, 0, ...next.splice(index, 1))
            log.info("channel-list move folder", { delta })
            void runWrite("reorder", [], () => latest.current.options.onReorderFolders!(next))
          }
        : undefined,
    [hasReorderFolders, orderedFolderIds, runWrite]
  )

  return {
    handleNewDirect,
    handleNewTeamConversation,
    ...rowBundle,
    renamingFolderId,
    handleNewFolder,
    handleNewFolderWith,
    handleFolderRenameSettled,
    handleMoveFolder,
  }
}
