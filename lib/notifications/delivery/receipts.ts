// Notification V2 receipt projection — maps an outbound job's outcome onto
// the owning delivery intent, and appends the attempt evidence.
//
// The governed intent and its outbound job share `operationKey`
// (`outboundQueue.notificationOperationKey`), but their lifecycles are
// deliberately separate: the outbound RUNNER owns the network send + retry,
// while the intent is the durable *intent* the operator reads. The receipt
// projector is the bridge — it watches notification-sourced jobs and folds
// their status back onto the intent + an append-only attempt.
//
// Idempotent by construction: a job's status projects onto the intent's
// state machine monotonically, and a TERMINAL projection (accepted / failed
// / delivery-unknown) is applied once — a re-sweep sees the intent already
// terminal and skips. A crash between "job sent" and "intent updated" is
// recovered here from the job's own evidence — the reconciler never re-sends
// to make the intent look right.
//
// Error → outcome mapping honors the design's classification table:
//   429/Retry-After → rate-limited   token → auth-failed   missing target →
//   invalid-target   timeout → timeout-unknown   else → network-error.

import { getDb } from "@/lib/db/schema"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import type {
  NotificationAttemptOutcome,
  NotificationIntentStatus,
} from "@/types/notifications/delivery"
import {
  appendDeliveryAttempt,
  getIntentByOperationKey,
  transitionIntent,
  TERMINAL_INTENT_STATUSES,
} from "@/lib/db/notification-delivery"
import { commitPublicationRender, getPublication } from "@/lib/db/notification-publications"

/** How an outbound job's lastErrorCode classifies for the attempt log. */
export function classifyOutboundError(job: OutboundJobRow): NotificationAttemptOutcome {
  const code = (job.lastErrorCode ?? "").toLowerCase()
  if (code.includes("rate") || code.includes("429") || code.includes("retry_after")) {
    return "rate-limited"
  }
  if (
    code.includes("auth") ||
    code.includes("token") ||
    code.includes("401") ||
    code.includes("403")
  ) {
    return "auth-failed"
  }
  if (
    code.includes("not_found") ||
    code.includes("invalid_target") ||
    code.includes("forbidden_chat")
  ) {
    return "invalid-target"
  }
  if (code.includes("content") || code.includes("payload") || code.includes("bad_request")) {
    return "content-rejected"
  }
  if (code.includes("timeout") || code.includes("unknown")) {
    return "timeout-unknown"
  }
  return "network-error"
}

/** The intent status a terminal job status projects to. */
function intentStatusForTerminalJob(
  job: OutboundJobRow
): { status: NotificationIntentStatus; outcome: NotificationAttemptOutcome } | null {
  switch (job.status) {
    case "sent":
      return { status: "accepted", outcome: "accepted" }
    case "deadlettered": {
      const outcome = classifyOutboundError(job)
      return outcome === "invalid-target" ||
        outcome === "auth-failed" ||
        outcome === "content-rejected"
        ? { status: "rejected", outcome }
        : { status: "failed", outcome }
    }
    case "delivery_unknown":
      return { status: "delivery-unknown", outcome: "timeout-unknown" }
    default:
      return null
  }
}

/**
 * Project ONE outbound job's status onto its notification intent. Returns
 * the transition applied, or `null` when nothing changed (non-notification
 * job, no intent, or already projected). Safe to re-run — terminal
 * projections are idempotent.
 */
export async function projectOutboundJobReceipt(
  job: OutboundJobRow,
  now = Date.now()
): Promise<{ intentId: string; status: NotificationIntentStatus } | null> {
  const operationKey = job.notificationOperationKey
  if (!operationKey) return null
  const intent = await getIntentByOperationKey(operationKey)
  if (!intent) return null

  // Terminal job → terminal intent + one attempt. Idempotent: if the intent
  // is already terminal this exact evidence is already recorded — skip.
  const terminal = intentStatusForTerminalJob(job)
  if (terminal) {
    if (TERMINAL_INTENT_STATUSES.includes(intent.status)) return null
    const db = getDb()
    const applied = await db.transaction(
      "rw",
      [db.notificationDeliveryIntents, db.notificationDeliveryAttempts],
      async () => {
        const moved = await transitionIntent(
          intent.id,
          ["prepared", "queued", "sending"],
          {
            status: terminal.status,
          },
          db
        )
        if (!moved) return null
        await appendDeliveryAttempt(
          {
            intentId: intent.id,
            outcome: terminal.outcome,
            ...(terminal.outcome === "accepted" && job.platformMessageId
              ? { receipt: { platformMessageId: job.platformMessageId } }
              : {}),
            ...(job.lastErrorCode ? { errorCode: job.lastErrorCode } : {}),
            startedAt: job.claimedAt ?? job.updatedAt ?? now,
            outboundJobId: job.id,
          },
          db
        )
        return moved
      }
    )
    if (!applied) return null

    // Fold the platform receipt onto the publication — the message handle +
    // accepted content hash are the "what the platform acknowledged" truth.
    if (terminal.status === "accepted" && intent.publicationId) {
      const pub = await getPublication(intent.publicationId)
      if (pub) {
        await commitPublicationRender(pub.id, pub.renderedRevision, {
          platformMessageId: job.platformMessageId,
          acceptedContentHash: intent.payload.contentHash,
        })
      }
    }
    return { intentId: intent.id, status: terminal.status }
  }

  // Non-terminal status sync — `sending`/`pending`/`failed`(retrying) mirror
  // onto the intent's live status without appending an attempt.
  const mirror: NotificationIntentStatus | null =
    job.status === "sending"
      ? "sending"
      : job.status === "pending" || job.status === "failed"
        ? "queued"
        : null
  if (!mirror || intent.status === mirror) return null
  const moved = await transitionIntent(intent.id, ["prepared", "queued", "sending"], {
    status: mirror,
  })
  return moved ? { intentId: intent.id, status: mirror } : null
}

/**
 * The reconciler's receipt sweep — scan notification-sourced jobs whose
 * status may not have projected, and fold each onto its intent. Bounded to
 * `limit` per pass; the runtime calls it on the reconcile tick.
 */
export async function reconcileNotificationReceipts(opts?: {
  now?: number
  limit?: number
}): Promise<{ projected: number; scanned: number }> {
  const now = opts?.now ?? Date.now()
  const limit = opts?.limit ?? 128
  const db = getDb()
  // Notification-sourced jobs that reached a terminal status — the ones whose
  // receipt evidence must be on the intent. Scan bounded; the unique
  // notificationOperationKey index makes the intent join exact.
  const terminalJobs = await db.outboundQueue
    .where("status")
    .anyOf("sent", "deadlettered", "delivery_unknown")
    .filter((j) => j.notificationOperationKey !== undefined)
    .limit(limit)
    .toArray()
  let projected = 0
  for (const job of terminalJobs) {
    if (await projectOutboundJobReceipt(job, now)) projected += 1
  }
  return { projected, scanned: terminalJobs.length }
}
