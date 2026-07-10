"use client"

/**
 * Background-run completion delivery (the OpenCode `resumeWhenIdle` pattern).
 *
 * When a background `dispatch_agent` run settles, its result is re-injected
 * into the PARENT chat session as a framed turn — so the model reacts to the
 * outcome without polling `collect` — plus a Notification Center entry/toast.
 * Mid-turn injection is impossible (the sidecar restarts a session on a
 * same-session send while streaming), so delivery follows the steer-queue
 * rule: parent streaming ⇒ stay queued, drain when the turn settles; parent
 * closed ⇒ drain when it next opens idle; parent deleted ⇒ notification only.
 *
 * Durable state lives on the journal row (`deliveryState`); the in-memory
 * queue seeded from the settle payload avoids racing the async journal write.
 * Module-scope (mirrors `steer-runtime.ts`) so lib code and both chat hooks
 * share one registration.
 */

import type {
  BackgroundTaskJournalRecord,
  BackgroundTaskSettleInfo,
  BackgroundTaskStartMeta,
} from "@/lib/background-tasks/registry-core"
import {
  deliveryEntryFromJournal,
  formatElapsed,
  frameBackgroundResults,
  type BackgroundResultDeliveryEntry,
} from "@/lib/background-tasks/completion-delivery"
import { isSessionOpen, sessionStatusOf } from "./steer-runtime"

/** Hook-bound send used to inject the framed turn into a session. */
export type BackgroundReplaySend = (framedText: string, sessionId: string) => void

/** Localized notification copy, supplied by the registering component. */
export interface BackgroundResultNotifyStrings {
  title: (p: { subagentId: string; status: "done" | "error"; elapsed: string }) => string
  body: (p: { runId: string }) => string
}

let replaySend: BackgroundReplaySend | undefined
let notifyStrings: BackgroundResultNotifyStrings | undefined
/** In-memory pending queue: parentSessionId → runId → entry. */
const pendingBySession = new Map<string, Map<string, BackgroundResultDeliveryEntry>>()
const deliveryLocks = new Set<string>()

/** Register the chat hook's send (returns an unregister for unmount). */
export function registerBackgroundReplaySend(send: BackgroundReplaySend): () => void {
  replaySend = send
  return () => {
    if (replaySend === send) replaySend = undefined
  }
}

/** Register localized notification copy (boot initializer). */
export function registerBackgroundResultNotifyStrings(
  strings: BackgroundResultNotifyStrings
): () => void {
  notifyStrings = strings
  return () => {
    if (notifyStrings === strings) notifyStrings = undefined
  }
}

export function __resetBackgroundResultRuntimeForTesting(): void {
  replaySend = undefined
  notifyStrings = undefined
  pendingBySession.clear()
  deliveryLocks.clear()
}

/**
 * Settle listener for the renderer background registry (wired by the boot
 * initializer via `setRendererBackgroundSettleListener`). Fires the completion
 * notification, marks the journal row `pending`, and attempts delivery.
 */
export function onBackgroundRunSettled(
  runId: string,
  meta: BackgroundTaskStartMeta,
  settle: BackgroundTaskSettleInfo
): void {
  if (meta.kind !== "subagent" || meta.host !== "renderer") return
  const entry = deliveryEntryFromJournal({
    runId,
    subagentId: meta.subagentId,
    status: settle.status,
    startedAt: meta.startedAt,
    settledAt: settle.settledAt,
    ...(settle.resultText !== undefined ? { resultText: settle.resultText } : {}),
    ...(settle.error !== undefined ? { error: settle.error } : {}),
  })
  if (!entry) return
  let bucket = pendingBySession.get(meta.sessionId)
  if (!bucket) {
    bucket = new Map()
    pendingBySession.set(meta.sessionId, bucket)
  }
  bucket.set(runId, entry)
  // Durable mirror for relaunch (best-effort; the in-memory entry drives the
  // live path so this never races the async settle write).
  void markDeliveryState([runId], "pending")
  void fireCompletionNotification(runId, meta, entry)
  void attemptBackgroundResultDelivery(meta.sessionId)
}

/**
 * Drain a session's pending background results when it is open + idle. Called
 * from the chat hook at turn settle (AFTER the steer drain — a steer replay
 * that starts a new turn simply defers this to the next settle) and when a
 * session (re)opens.
 */
export function maybeDrainBackgroundResults(sessionId: string): void {
  void attemptBackgroundResultDelivery(sessionId)
}

/**
 * Deliver every pending entry for the session as ONE framed turn. Per-session
 * mutex; leaves entries pending when the parent is busy/closed or no send is
 * registered; marks them orphaned when the parent session no longer exists.
 */
export async function attemptBackgroundResultDelivery(sessionId: string): Promise<void> {
  if (!sessionId || deliveryLocks.has(sessionId)) return
  deliveryLocks.add(sessionId)
  try {
    const entries = await collectDeliverable(sessionId)
    if (entries.length === 0) return

    const session = await readSession(sessionId)
    if (!session) {
      pendingBySession.delete(sessionId)
      await markDeliveryState(
        entries.map((e) => e.runId),
        "orphaned"
      )
      return
    }

    const send = replaySend
    if (!send) return
    if (!isSessionOpen(sessionId) || sessionStatusOf(sessionId) !== "idle") return

    send(frameBackgroundResults(entries), sessionId)
    pendingBySession.delete(sessionId)
    await markDeliveryState(
      entries.map((e) => e.runId),
      "delivered"
    )
  } finally {
    deliveryLocks.delete(sessionId)
  }
}

/** Union of the in-memory queue and journal `pending` rows (in-memory wins). */
async function collectDeliverable(sessionId: string): Promise<BackgroundResultDeliveryEntry[]> {
  const byRunId = new Map<string, BackgroundResultDeliveryEntry>()
  for (const record of await readPendingJournalRows(sessionId)) {
    const entry = deliveryEntryFromJournal(record)
    if (entry) byRunId.set(record.runId, entry)
  }
  for (const [runId, entry] of pendingBySession.get(sessionId) ?? []) {
    byRunId.set(runId, entry)
  }
  return [...byRunId.values()]
}

async function readPendingJournalRows(sessionId: string): Promise<BackgroundTaskJournalRecord[]> {
  try {
    const { listBackgroundTaskRecords } = await import("@/lib/db/background-tasks")
    const rows = await listBackgroundTaskRecords({ host: "renderer" })
    return rows.filter(
      (row) =>
        row.sessionId === sessionId &&
        row.kind === "subagent" &&
        row.deliveryState === "pending" &&
        (row.status === "done" || row.status === "error")
    )
  } catch {
    return []
  }
}

async function readSession(sessionId: string) {
  try {
    const { getSession } = await import("@/lib/db/sessions")
    return await getSession(sessionId)
  } catch {
    // If the session table is unreadable, err on the side of keeping entries
    // pending rather than marking them orphaned.
    return { id: sessionId }
  }
}

async function markDeliveryState(
  runIds: string[],
  deliveryState: "pending" | "delivered" | "orphaned"
): Promise<void> {
  try {
    const { updateBackgroundTaskRecord } = await import("@/lib/db/background-tasks")
    const deliveredAt = deliveryState === "delivered" ? { deliveredAt: Date.now() } : {}
    await Promise.all(
      runIds.map((runId) => updateBackgroundTaskRecord(runId, { deliveryState, ...deliveredAt }))
    )
  } catch {
    // Best-effort durable mirror; the in-memory queue already drove delivery.
  }
}

async function fireCompletionNotification(
  runId: string,
  meta: BackgroundTaskStartMeta,
  entry: BackgroundResultDeliveryEntry
): Promise<void> {
  try {
    const { notify } = await import("@/lib/notifications/runtime")
    const elapsed = formatElapsed(entry.settledAt - entry.startedAt)
    const strings = notifyStrings
    const title = strings
      ? strings.title({ subagentId: meta.subagentId, status: entry.status, elapsed })
      : `Background subagent "${meta.subagentId}" ${entry.status === "done" ? "finished" : "failed"} (${elapsed})`
    const body = strings ? strings.body({ runId }) : `Run ${runId}`
    await notify({
      source: "session",
      level: entry.status === "done" ? "success" : "error",
      title,
      body,
      channels: ["center", "toast"],
      groupKey: runId,
      sourceRef: { kind: "background-run", id: runId },
      directed: true,
    })
  } catch {
    // Notifications are best-effort; delivery/journal state is unaffected.
  }
}
