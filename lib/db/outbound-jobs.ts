/**
 * CRUD layer for the `outboundQueue` Dexie table (schema v18, extended at v41).
 *
 * Outbound delivery jobs are processed FIFO per conversation lane.
 * The runner uses `pickNextDue` to claim the oldest pending row whose
 * `nextAttemptAt <= now`, then transitions it through the lifecycle:
 * pending → sending → sent | failed | deadlettered.
 *
 * Provenance: every enqueue MUST declare a `source` (added at v41) so the
 * inbox UI can render the right badge and the audit log can drill down on
 * origin. Rows persisted before v41 backfill to `"ai-run"` via the v41
 * upgrade hook — but new rows MUST declare explicitly; the type system
 * enforces this so a workflow-pushed message never silently looks like an
 * ai-run reply.
 */

import { liveQuery } from "dexie"
import type {
  OutboundJobRow,
  OutboundJobSource,
  OutboundJobWorkflowSource,
} from "./connector-types"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { getDb } from "./schema"
import { append as appendConnectorAudit } from "./connector-audit"
import { resolveScopeProjectId } from "./project-scope"

/**
 * Soft cap on the `outboundQueue` table. When `enqueueOutbound` brings the
 * total past this watermark we age the oldest still-pending rows to
 * `deadlettered` and emit an audit row per aged job. The cap is
 * intentionally permissive: real-world backlogs rarely exceed a few hundred
 * rows even during a sustained adapter outage, so 5000 only trips on a
 * cascading failure where every adapter is jammed at once. The dead-letter
 * transition preserves the row so the operator can still inspect it via
 * the Outbound tab; it just stops the runner from re-trying.
 *
 * Exported for the saturation banner threshold derivation + tests.
 */
export const OUTBOUND_QUEUE_SOFT_CAP = 5000

function newId(): string {
  return "oqj_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

// ── Enqueue wake signal ────────────────────────────────────────────────────
//
// The outbound runner used to busy-poll `pickNextDue` every 200ms. It now
// sleeps until either the next retry deadline or a fresh enqueue. This bus is
// the "fresh enqueue" wake: `enqueueOutbound` fires it from the single
// chokepoint that every enqueue path (ai-run, manual, workflow, draft) flows
// through, so the runner wakes for all of them without each call-site knowing
// about the runner. Built on `EventTarget` exactly like
// `lib/connectors/credentials-events.ts` — works in the browser shell and the
// Tauri webview alike, and keeps the connector→db dependency direction intact
// (the runner imports this; this module imports nothing from lib/connectors).

const OUTBOUND_ENQUEUED_EVENT = "connectors:outbound:enqueued"
const outboundBus: EventTarget = new EventTarget()

/**
 * Subscribe to "an outbound job was enqueued" notifications. Returns an
 * unsubscribe function. The handler receives no payload — it's a pure wake
 * signal; the runner re-queries the table to decide what to do.
 */
export function subscribeOutboundEnqueued(handler: () => void): () => void {
  const listener = () => {
    try {
      handler()
    } catch (err) {
      console.error(
        "[outbound-jobs] enqueue subscriber threw:",
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  outboundBus.addEventListener(OUTBOUND_ENQUEUED_EVENT, listener)
  return () => outboundBus.removeEventListener(OUTBOUND_ENQUEUED_EVENT, listener)
}

function emitOutboundEnqueued(): void {
  outboundBus.dispatchEvent(new Event(OUTBOUND_ENQUEUED_EVENT))
}

export interface EnqueueInput {
  adapterId: string
  conversationKey: string
  request: OutboundRequest
  /** Override nextAttemptAt — defaults to now (immediate). */
  nextAttemptAt?: number
  /**
   * Provenance of this enqueue. Required at schema v41+. The four legal
   * values correspond to the four paths that can produce an outbound:
   * the connector ai-loop reply (`"ai-run"`), the inbox manual composer
   * (`"manual"`), a Visual Workflow `action.connector.send` node
   * (`"workflow"`, in which case `sourceWorkflow` MUST also be set), or a
   * draft approval (`"draft-approved"`).
   */
  source: OutboundJobSource
  /**
   * Workflow back-reference. Required when `source === "workflow"`,
   * ignored otherwise.
   */
  sourceWorkflow?: OutboundJobWorkflowSource
}

export async function enqueueOutbound(input: EnqueueInput): Promise<OutboundJobRow> {
  const now = Date.now()
  // Workspace isolation (Dexie v86): attribute the job to the conversation's
  // workspace (via its override row), falling back to the active project.
  const override = await getDb()
    .conversationOverrides.where("conversationKey")
    .equals(input.conversationKey)
    .first()
  const projectId = override?.projectId ?? (await resolveScopeProjectId())
  const row: OutboundJobRow = {
    id: newId(),
    adapterId: input.adapterId,
    projectId,
    conversationKey: input.conversationKey,
    request: input.request,
    status: "pending",
    attempts: 0,
    createdAt: now,
    nextAttemptAt: input.nextAttemptAt ?? now,
    idempotencyKey: input.request.metadata.idempotencyKey,
    source: input.source,
    ...(input.source === "workflow" && input.sourceWorkflow
      ? { sourceWorkflow: input.sourceWorkflow }
      : {}),
  }
  await getDb().outboundQueue.add(row)
  await enforceQueueSoftCap(now)
  // Wake the runner — `row.nextAttemptAt` defaults to `now`, so this is
  // immediately actionable unless the caller scheduled it for the future.
  emitOutboundEnqueued()
  return row
}

/** Terminal outbound statuses — the job will never transition again. */
export function isOutboundTerminal(status: OutboundJobRow["status"]): boolean {
  return status === "sent" || status === "deadlettered"
}

/**
 * Max reroute hops `waitForOutboundTerminal` will follow before giving up and
 * returning the last row as-is. The runner's single-hop reroute guard already
 * bounds real chains to depth 1; this is a defensive loop cap.
 */
const MAX_REROUTE_HOPS = 3

/**
 * Resolve with the job row once it reaches a terminal state (`sent` /
 * `deadlettered`), or with the LATEST snapshot when `timeoutMs` elapses
 * first — callers distinguish "still retrying" from "failed terminally" by
 * inspecting `status`. Resolves `undefined` when the job id is unknown.
 *
 * **Reroute-aware:** when a terminal row is `deadlettered` with a
 * `reroutedToJobId` (the runner moved the delivery to a sibling bot via
 * failover / load-balance), this FOLLOWS the pointer and waits on the sibling
 * with the remaining timeout — so a caller awaiting the original job learns
 * the delivery's TRUE outcome (the sibling's `sent` + real `platformMessageId`)
 * instead of misreading the reroute as a failure.
 *
 * Event-driven via Dexie `liveQuery` (no polling). Shared by the plugin
 * delivery-feedback API (`ctx.connectors.waitForDelivery`) and the
 * `action.connector.send` workflow node's `waitForDelivery` param.
 */
export async function waitForOutboundTerminal(
  jobId: string,
  timeoutMs: number
): Promise<OutboundJobRow | undefined> {
  const deadline = Date.now() + timeoutMs
  let currentId = jobId
  for (let hop = 0; hop <= MAX_REROUTE_HOPS; hop++) {
    const remaining = Math.max(0, deadline - Date.now())
    const row = await waitForTerminalRaw(currentId, remaining)
    if (!row) return undefined
    if (
      row.status === "deadlettered" &&
      row.reroutedToJobId &&
      row.reroutedToJobId !== currentId &&
      hop < MAX_REROUTE_HOPS
    ) {
      currentId = row.reroutedToJobId
      continue
    }
    return row
  }
  return getDb().outboundQueue.get(currentId)
}

/**
 * Single-job terminal wait (no reroute following). The public
 * {@link waitForOutboundTerminal} wraps this to walk reroute chains.
 */
async function waitForTerminalRaw(
  jobId: string,
  timeoutMs: number
): Promise<OutboundJobRow | undefined> {
  const initial = await getDb().outboundQueue.get(jobId)
  if (!initial) return undefined
  if (isOutboundTerminal(initial.status)) return initial
  return new Promise<OutboundJobRow>((resolve) => {
    let latest = initial
    const subscription = liveQuery(() => getDb().outboundQueue.get(jobId)).subscribe({
      next: (row) => {
        if (!row) return
        latest = row
        if (isOutboundTerminal(row.status)) {
          cleanup()
          resolve(row)
        }
      },
      error: () => {
        cleanup()
        resolve(latest)
      },
    })
    const timer = setTimeout(() => {
      cleanup()
      resolve(latest)
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      try {
        subscription.unsubscribe()
      } catch {
        // best-effort
      }
    }
  })
}

/**
 * If the outboundQueue exceeds `OUTBOUND_QUEUE_SOFT_CAP`, transition the
 * oldest still-pending rows to `deadlettered` until the table is back
 * under the cap. Each aged row emits a `outbound.queue_capped` audit row
 * carrying the job id and its age in ms, so the operator can correlate
 * the banner trip with the specific jobs that were dropped. Sending /
 * failed / already-deadlettered rows are NOT aged — they're either in
 * flight or already terminal.
 *
 * Best-effort: a failure to write the audit row must not block the
 * dead-letter transition.
 */
async function enforceQueueSoftCap(now: number): Promise<void> {
  const db = getDb()
  const total = await db.outboundQueue.count()
  if (total <= OUTBOUND_QUEUE_SOFT_CAP) return
  const overflow = total - OUTBOUND_QUEUE_SOFT_CAP
  const oldestPending = await db.outboundQueue.where("status").equals("pending").toArray()
  oldestPending.sort((a, b) => a.createdAt - b.createdAt)
  const victims = oldestPending.slice(0, overflow)
  for (const job of victims) {
    await db.outboundQueue.update(job.id, {
      status: "deadlettered",
      lastErrorCode: "queue_capped",
      lastError: `outboundQueue exceeded soft cap of ${OUTBOUND_QUEUE_SOFT_CAP}`,
    })
    try {
      await appendConnectorAudit({
        adapterId: job.adapterId,
        kind: "outbound.queue_capped",
        at: now,
        conversationKey: job.conversationKey,
        idempotencyKey: job.idempotencyKey,
        message: `aged pending job to deadlettered (queue overflow)`,
        fields: {
          jobId: job.id,
          ageMs: now - job.createdAt,
          createdAt: job.createdAt,
          source: job.source,
        },
      })
    } catch {
      // Best-effort — audit failure must not block the dead-letter transition.
    }
  }
}

/**
 * Return the oldest actionable row with `nextAttemptAt <= now`, or undefined
 * if nothing is due. Picks both "pending" (first attempt) and "failed"
 * (scheduled retry) rows. Does not mutate the row — caller must call
 * `markSending`.
 *
 * Uses the `[status+nextAttemptAt]` compound index (v51): two bounded range
 * scans (`pending` + `failed`, each `nextAttemptAt <= now`) instead of a
 * full-table `.filter()`. In steady state most rows are `sent`/`deadlettered`
 * and never enter either range, so the query cost tracks the number of *due*
 * jobs, not the table size.
 */
export async function pickNextDue(): Promise<OutboundJobRow | undefined> {
  return (await listDueNow())[0]
}

/**
 * All actionable rows (`pending` or `failed`, `nextAttemptAt <= now`) ordered
 * oldest-first by `createdAt`. The event-driven runner drains this batch into
 * per-conversation lanes in one pass per wake, instead of re-querying for one
 * job per poll tick. Same `[status+nextAttemptAt]` index as `pickNextDue`.
 */
export async function listDueNow(): Promise<OutboundJobRow[]> {
  const now = Date.now()
  const db = getDb()
  const [pending, failed] = await Promise.all([
    db.outboundQueue
      .where("[status+nextAttemptAt]")
      .between(["pending", -Infinity], ["pending", now], true, true)
      .toArray(),
    db.outboundQueue
      .where("[status+nextAttemptAt]")
      .between(["failed", -Infinity], ["failed", now], true, true)
      .toArray(),
  ])
  return [...pending, ...failed].sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * The earliest future `nextAttemptAt` across all `pending`/`failed` rows
 * (strictly after `now`), or undefined when nothing is scheduled. The
 * event-driven runner sleeps until exactly this instant so a deferred retry
 * (rate-limit / quiet-hours / backoff) fires on time without polling.
 *
 * Rows due at-or-before `now` are intentionally excluded — those are handled
 * by `pickNextDue`; this answers only "when is the next *future* wake?".
 */
export async function peekNextWakeAt(): Promise<number | undefined> {
  const now = Date.now()
  const db = getDb()
  const [pending, failed] = await Promise.all([
    db.outboundQueue
      .where("[status+nextAttemptAt]")
      .between(["pending", now], ["pending", Infinity], false, true)
      .first(),
    db.outboundQueue
      .where("[status+nextAttemptAt]")
      .between(["failed", now], ["failed", Infinity], false, true)
      .first(),
  ])
  const times = [pending?.nextAttemptAt, failed?.nextAttemptAt].filter(
    (t): t is number => typeof t === "number"
  )
  return times.length === 0 ? undefined : Math.min(...times)
}

/**
 * Return all pending rows for a conversation, ordered by createdAt (FIFO).
 */
export async function listPendingForConversation(
  conversationKey: string
): Promise<OutboundJobRow[]> {
  return getDb()
    .outboundQueue.where("[conversationKey+createdAt]")
    .between([conversationKey, -Infinity], [conversationKey, Infinity])
    .filter((r) => r.status === "pending")
    .toArray()
}

/**
 * Atomically claim a job for sending: transition `pending`/`failed` → `sending`
 * and increment attempts, inside a single Dexie transaction. Returns `true` if
 * THIS caller won the claim, `false` if the row was already claimed by another
 * runner (or moved to a terminal status) — the Dexie analog of a `SELECT … FOR
 * UPDATE` claim. Without the transaction two runners (e.g. a second `main`
 * webview) could both read `pending` and both send the same message.
 */
export async function markSending(jobId: string): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.outboundQueue, async () => {
    const row = await db.outboundQueue.get(jobId)
    if (!row || (row.status !== "pending" && row.status !== "failed")) {
      return false
    }
    await db.outboundQueue.update(jobId, {
      status: "sending",
      attempts: (row.attempts ?? 0) + 1,
    })
    return true
  })
}

/**
 * Transition a job to "sent" and persist the platform-side message id so
 * downstream consumers (workflow-progress-runner in-place edit, future
 * reaction routing) can recover the handle from the row without a second
 * adapter round-trip.
 */
export async function markSent(jobId: string, platformMessageId: string): Promise<void> {
  await getDb().outboundQueue.update(jobId, {
    status: "sent",
    platformMessageId,
  })
}

/** Transition a job to "failed" with error info and next retry time. */
export async function markFailed(
  jobId: string,
  errorCode: string,
  message: string,
  nextAttemptAt: number
): Promise<void> {
  await getDb().outboundQueue.update(jobId, {
    status: "failed",
    lastErrorCode: errorCode,
    lastError: message,
    nextAttemptAt,
  })
}

/**
 * Transition a job to "deadlettered" — no more retries. When the dead-letter
 * is a reroute (the runner moved the delivery to a sibling bot), pass
 * `reroute` so the row points at the sibling job that actually carries the
 * delivery; `waitForOutboundTerminal` follows that pointer so a caller
 * awaiting THIS job sees the sibling's real terminal status, not a false
 * failure.
 */
export async function markDeadlettered(
  jobId: string,
  errorCode: string,
  message: string,
  reroute?: { toJobId: string; mechanism: "failover" | "balanced" }
): Promise<void> {
  await getDb().outboundQueue.update(jobId, {
    status: "deadlettered",
    lastErrorCode: errorCode,
    lastError: message,
    ...(reroute ? { reroutedToJobId: reroute.toJobId, reroutedMechanism: reroute.mechanism } : {}),
  })
}

/**
 * Replay a dead-lettered job: reset its lifecycle so the outbound runner
 * picks it up again on the next poll. Clears the error state and re-arms the
 * attempt counter. Only acts on `deadlettered` rows — replaying a row that's
 * still active would race the runner. Returns the refreshed row, or
 * `undefined` when the job doesn't exist or isn't dead-lettered. Emits the
 * enqueue wake event so a dormant runner re-checks `pickNextDue`.
 *
 * Audit (`outbound.replayed`) is the caller's responsibility — this fn stays
 * in the lib/db layer (no audit dep). The Inbox/Settings DLQ panel records
 * the audit alongside the original error code.
 */
export async function replayDeadlettered(jobId: string): Promise<OutboundJobRow | undefined> {
  const db = getDb()
  const row = await db.outboundQueue.get(jobId)
  if (!row || row.status !== "deadlettered") return undefined
  const now = Date.now()
  const updated: Partial<OutboundJobRow> = {
    status: "pending",
    attempts: 0,
    lastError: undefined,
    lastErrorCode: undefined,
    nextAttemptAt: now,
  }
  await db.outboundQueue.update(jobId, updated)
  emitOutboundEnqueued()
  return { ...row, ...updated }
}
