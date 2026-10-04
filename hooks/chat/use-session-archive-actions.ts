"use client"

/**
 * Archive and restore conversations from a surface that is not a conversation
 * list: the archived banner inside an open chat, the send path that restores
 * an archived conversation, the conversation manager's header.
 *
 * The lists route the same writes through `useConversationRowActions`, which
 * also picks the row that opens next. These surfaces have no rendered order to
 * pick from, so they share only the parts that must not drift: the routed
 * write (`setSessionsArchived`), the handoff-lock gate and failure toasts
 * (`useSessionWrite`), the words, and an Undo on every toast — a conversation
 * that changes sides leaves the view the user was looking at.
 *
 * Both handlers resolve `true` when the write landed and `false` when it was
 * refused or failed (already said so); they never reject.
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"

import { useSessionWrite } from "@/hooks/chat/use-session-write"
import { setSessionsArchived } from "@/lib/chat/session-archive-writes"
import { trackConversationRowAction } from "@/lib/telemetry/conversation-list-events"

export interface UnarchiveOptions {
  /**
   * Why the conversation is coming back. `send` — the user wrote into it, so
   * the toast says where it went rather than echoing a button they never
   * pressed.
   */
  reason?: "user" | "send"
}

export interface SessionArchiveActions {
  archive: (rows: readonly ChatSession[]) => Promise<boolean>
  unarchive: (rows: readonly ChatSession[], options?: UnarchiveOptions) => Promise<boolean>
}

export function useSessionArchiveActions(): SessionArchiveActions {
  const tBulk = useTranslations("desktop.channelList.bulk")
  const tRow = useTranslations("desktop.channelList.rowToast")
  const tArchive = useTranslations("conversations.archive")
  const runWrite = useSessionWrite()
  const latest = useRef({ tBulk, tRow, tArchive })
  useEffect(() => {
    latest.current = { tBulk, tRow, tArchive }
  })

  const write = useCallback(
    async (rows: readonly ChatSession[], archived: boolean, options?: UnarchiveOptions) => {
      // Only the rows that actually change sides: re-archiving an archived row
      // would restamp `archivedAt`, and an Undo must reverse exactly this.
      const targets = rows.filter((row) => (row.archivedAt != null) !== archived)
      if (targets.length === 0) return true
      const ids = targets.map((row) => row.id)
      const { tBulk: bulk, tRow: rowT, tArchive: archiveT } = latest.current
      void trackConversationRowAction(archived ? "archive" : "unarchive", ids.length)
      const success = archived
        ? bulk("archiveSuccess", { count: ids.length })
        : options?.reason === "send"
          ? archiveT("restoredBySend")
          : bulk("unarchiveSuccess", { count: ids.length })
      return runWrite(
        archived ? "archive" : "unarchive",
        targets,
        () => setSessionsArchived(ids, archived),
        {
          success,
          undo: {
            label: rowT("undo"),
            run: () => setSessionsArchived(ids, !archived),
          },
        }
      )
    },
    [runWrite]
  )

  return useMemo(
    () => ({
      archive: (rows) => write(rows, true),
      unarchive: (rows, options) => write(rows, false, options),
    }),
    [write]
  )
}
