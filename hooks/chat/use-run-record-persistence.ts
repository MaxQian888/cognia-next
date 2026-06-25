"use client"

/**
 * `useRunRecordPersistence(sessionId)` — snapshots the bound session's current
 * turn into the durable `runRecords` Dexie table so the Run Panel's "second
 * clock" survives scroll, refresh, and restart. Writes are debounced while a
 * turn streams and flushed immediately (then pruned) when it settles. A turn
 * with no work is never persisted.
 *
 * Mounted once per chat pane (alongside the Run Panel) in `chat-view`.
 */
import { useEffect, useRef } from "react"

import {
  useSessionMessages,
  useSessionRunId,
  useSessionRunTiming,
  useSessionStatus,
  useSessionToolTimestamps,
} from "@/stores/chat"
import { deriveRunRecord, toRunStatus } from "@/lib/claude/run-record"
import { pruneRunRecords, runRecordRowFromView, upsertRunRecord } from "@/lib/db/run-records"

const PERSIST_DEBOUNCE_MS = 400
const PRUNE_KEEP = 20

export function useRunRecordPersistence(sessionId: string | null): void {
  const status = useSessionStatus(sessionId)
  const timing = useSessionRunTiming(sessionId)
  const runId = useSessionRunId(sessionId)
  const messages = useSessionMessages(sessionId)
  const toolTimestamps = useSessionToolTimestamps(sessionId)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasBusyRef = useRef(false)

  useEffect(() => {
    if (!sessionId) return undefined

    const busy = status === "streaming" || status === "awaiting_approval"
    const view = deriveRunRecord({
      sessionId,
      runId,
      messages,
      runTiming: timing,
      status: toRunStatus(status),
      toolTimestamps,
    })
    const hasWork = view.tools.length > 0 || view.todos.length > 0 || view.subagentParts.length > 0

    const settled = wasBusyRef.current && !busy
    wasBusyRef.current = busy

    // Only persist a real turn (runId >= 1 — a fresh slice / post-reload session
    // sits at 0 until the first turn mints one, even though reloaded messages may
    // still carry work). A turn with no work is never persisted.
    const row = (view.runId ?? 0) >= 1 && hasWork ? runRecordRowFromView(view, Date.now()) : null
    if (!row) return undefined

    const write = () => {
      void upsertRunRecord(row)
        .then(() => pruneRunRecords(sessionId, PRUNE_KEEP))
        .catch(() => {})
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    // Immediate flush + prune the moment the turn settles; otherwise debounce so
    // a streaming turn doesn't write on every token.
    if (settled) {
      write()
      return undefined
    }

    timerRef.current = setTimeout(write, PERSIST_DEBOUNCE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [sessionId, status, timing, runId, messages, toolTimestamps])
}
