"use client"

/**
 * `useRunRecordPersistence(sessionId)` — snapshots the bound session's current
 * turn into the durable `runRecords` Dexie table so the Run Panel's "second
 * clock" survives scroll, refresh, and restart. Writes are debounced while a
 * turn streams and flushed immediately (then pruned) when it settles. A turn
 * with no work is never persisted.
 *
 * Mounted once per chat pane (alongside the Run Panel) in `chat-view`.
 *
 * Deliberately a TRANSIENT store subscription, not reactive selector hooks:
 * this hook only produces Dexie writes, so it must not re-render its host.
 * It is mounted at the top of `ChatPane`, and a reactive `useSessionMessages`
 * here made the entire pane (composer, header, docks) re-render on every
 * coalesced streaming frame — exactly what the pane's `useSessionHasMessages`
 * boolean subscription was built to avoid. The snapshot is derived lazily at
 * debounce-fire time, so token frames cost one field-compare and (at most)
 * one timer reschedule, not a `deriveRunRecord` walk.
 */
import { useEffect } from "react"

import { useChatStore } from "@/stores/chat"
import { IDLE_TIMING } from "@/lib/claude/run-status"
import { deriveRunRecord, toRunStatus } from "@/lib/claude/run-record"
import { pruneRunRecords, runRecordRowFromView, upsertRunRecord } from "@/lib/db/run-records"

const PERSIST_DEBOUNCE_MS = 400
const PRUNE_KEEP = 20

/** The slice fields whose changes can alter the persisted run record. */
function pickRelevant(sessionId: string) {
  const slice = useChatStore.getState().sessions[sessionId]
  return {
    status: slice?.status ?? "idle",
    runTiming: slice?.runTiming,
    runId: slice?.runId ?? 0,
    messages: slice?.messages,
    toolTimestamps: slice?.toolTimestamps,
  }
}

type Relevant = ReturnType<typeof pickRelevant>

function sameRelevant(a: Relevant, b: Relevant): boolean {
  return (
    a.status === b.status &&
    a.runTiming === b.runTiming &&
    a.runId === b.runId &&
    a.messages === b.messages &&
    a.toolTimestamps === b.toolTimestamps
  )
}

export function useRunRecordPersistence(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return undefined

    let timer: ReturnType<typeof setTimeout> | null = null
    let wasBusy = false

    // Derive + gate + write from the CURRENT store state. Running this at
    // debounce-fire time (rather than per store change) means the walk over
    // the turn's messages happens once per debounce window, and the row is
    // always the freshest snapshot.
    const write = () => {
      timer = null
      const s = pickRelevant(sessionId)
      const view = deriveRunRecord({
        sessionId,
        runId: s.runId,
        messages: s.messages ?? [],
        runTiming: s.runTiming ?? IDLE_TIMING,
        status: toRunStatus(s.status),
        toolTimestamps: s.toolTimestamps,
      })
      const hasWork =
        view.tools.length > 0 || view.todos.length > 0 || view.subagentParts.length > 0
      // Only persist a real turn (runId >= 1 — a fresh slice / post-reload
      // session sits at 0 until the first turn mints one, even though reloaded
      // messages may still carry work). A turn with no work is never persisted.
      if ((view.runId ?? 0) < 1 || !hasWork) return
      const row = runRecordRowFromView(view, Date.now())
      if (!row) return
      void upsertRunRecord(row)
        .then(() => pruneRunRecords(sessionId, PRUNE_KEEP))
        .catch(() => {})
    }

    const evaluate = (next: Relevant) => {
      const busy = next.status === "streaming" || next.status === "awaiting_approval"
      const settled = wasBusy && !busy
      wasBusy = busy

      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // Immediate flush + prune the moment the turn settles; otherwise debounce
      // so a streaming turn doesn't write on every token.
      if (settled) {
        write()
        return
      }
      timer = setTimeout(write, PERSIST_DEBOUNCE_MS)
    }

    let prev = pickRelevant(sessionId)
    const unsubscribe = useChatStore.subscribe(() => {
      const next = pickRelevant(sessionId)
      if (sameRelevant(next, prev)) return
      prev = next
      evaluate(next)
    })

    // Initial evaluation mirrors the old effect-on-mount behavior (a reloaded
    // mid-turn session re-persists its latest snapshot after the debounce).
    evaluate(prev)

    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [sessionId])
}
