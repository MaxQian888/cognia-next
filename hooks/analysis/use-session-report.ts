"use client"

/**
 * Live deep-session-analysis report for one chat session. Joins the persisted
 * `messages` + `sessionUsage` rows via Dexie live queries and memoizes the pure
 * {@link analyzeSession} over them, so the Insights sheet updates as the session
 * streams. Read-only — never writes.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import type { UIMessage } from "ai"

import { listMessages } from "@/lib/db/messages"
import { listUsageForSession, type SessionUsageRow } from "@/lib/db/session-usage"
import { analyzeSession, type SessionReport } from "@/lib/analysis/session-report"
import { deriveImportedUsageRows, type ImportedMessageLike } from "@/lib/session-import/usage"

export interface UseSessionReport {
  report: SessionReport | null
  loading: boolean
}

export function useSessionReport(
  sessionId: string | null | undefined,
  meta?: { title?: string }
): UseSessionReport {
  const messages = useLiveQuery<UIMessage[]>(
    () => (sessionId ? listMessages(sessionId) : Promise.resolve([])),
    [sessionId]
  )
  const usageRows = useLiveQuery<SessionUsageRow[]>(
    () => (sessionId ? listUsageForSession(sessionId) : Promise.resolve([])),
    [sessionId]
  )

  const loading = messages === undefined || usageRows === undefined

  const report = useMemo<SessionReport | null>(() => {
    if (!sessionId || loading) return null
    const msgs = messages ?? []
    // Imported external-agent sessions never emit live SDK `result` events, so
    // they carry no `sessionUsage` rows — fall back to the token/cost figures
    // the importer stamped onto each assistant message's `metadata.usage`.
    const rows =
      usageRows && usageRows.length > 0
        ? usageRows
        : deriveImportedUsageRows(msgs as unknown as ImportedMessageLike[])
    return analyzeSession({ messages: msgs, usageRows: rows, sessionMeta: meta }, {})
  }, [sessionId, loading, messages, usageRows, meta])

  return { report, loading }
}
