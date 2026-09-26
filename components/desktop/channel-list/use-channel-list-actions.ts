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
    handleFolderRenameSettled,
    handleMoveFolder,
  }
}
