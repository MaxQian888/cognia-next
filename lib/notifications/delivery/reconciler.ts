// Notification V2 reconciler — the compensatory sweep that survives a lost
// wake, a crashed projector, or an intent stranded mid-send.
//
// The wake signal (`notificationEnqueued`) is a HINT, never the reliability
// mechanism — this sweep is. It runs on a timer, on startup, on reconnect,
// and after every credential change, folding four classes of drift back to
// truth:
//
//   • Due projection work  — `listDueProjectionWork` rows (unclaimed /
//     lease-expired / blocked-due) get claimed + coordinated.
//   • Stale sends          — intents stuck `sending` past grace get reconciled
//     from their outbound job's evidence (never re-sent blindly).
//   • Due timers           — quiet-release / digest-flush / escalation /
//     approval-expiry timers that fired while we were down.
//   • Receipt drift        — notification-sourced jobs whose terminal status
//     hasn't projected onto the intent (receipts.ts).
//
// Bounded per pass — the design's "limited batch, not full-history scan".
// A row that fails stays blocked with backoff; it is NOT skipped.

import { getDb } from "@/lib/db/schema"
import { listDueProjectionWork, claimProjectionWork } from "@/lib/db/notification-projection-work"
import { listStaleSendingIntents, transitionIntent } from "@/lib/db/notification-delivery"
import { listDueTimers, fireNotificationTimer } from "@/lib/db/notification-timers"
import { coordinateProjectionWork, type EmitCenterRecord } from "./coordinator"
import { reconcileNotificationReceipts, projectOutboundJobReceipt } from "./receipts"
import type { NotificationPolicyContext } from "@/types/notifications/decision"
import type { NotificationTimer } from "@/types/notifications/delivery"

export interface ReconcileResult {
  claimedWork: number
  projectedReceipts: number
  staleSendsRecovered: number
  timersFired: number
  errors: number
}

/** How long a `sending` intent may sit before it's a crashed claim. */
const STALE_SENDING_GRACE_MS = 5 * 60 * 1000
/** Bounded batch per sweep — matches the design's 128-item reconcile cap. */
const SWEEP_BATCH = 128

/**
 * Run ONE reconcile pass for a scope. Claims + coordinates due work, recovers
 * stale sends, fires due timers, projects receipt drift. Returns the counts
 * so the runtime can log + the caller can test the sweep's coverage.
 */
export async function reconcileNotifications(input: {
  /**
   * The scope this reconciler owns — matched as a scopeKey PREFIX, so a
   * host reconciling its `{ns}:{account}` covers every workspace scopeKey
   * it wrote (the worker's own writes, never a foreign account's).
   */
  scopeKey: string
  policy: NotificationPolicyContext
  /** The lease-owner identity this reconciler claims work under. */
  leaseOwner: string
  /** In-app center emitter — forwarded to each coordinated work row. */
  emitCenter?: EmitCenterRecord
  now?: number
  batch?: number
}): Promise<ReconcileResult> {
  const now = input.now ?? Date.now()
  const batch = input.batch ?? SWEEP_BATCH
  const result: ReconcileResult = {
    claimedWork: 0,
    projectedReceipts: 0,
    staleSendsRecovered: 0,
    timersFired: 0,
    errors: 0,
  }

  // 1. Due projection work — claim + coordinate each, bounded. Prefix match
  //    on scopeKey so the account-level sweep covers all its workspace rows.
  const dueWork = (await listDueProjectionWork(now)).filter((w) =>
    w.scopeKey.startsWith(input.scopeKey)
  )
  for (const work of dueWork.slice(0, batch)) {
    try {
      const claimed = await claimProjectionWork(work.subjectKey, input.leaseOwner, now)
      if (!claimed) continue
      await coordinateProjectionWork({
        work: claimed,
        policy: input.policy,
        leaseOwner: input.leaseOwner,
        ...(input.emitCenter ? { emitCenter: input.emitCenter } : {}),
        now,
      })
      result.claimedWork += 1
    } catch {
      result.errors += 1
    }
  }

  // 2. Receipt drift — fold terminal job statuses onto their intents.
  try {
    const receipts = await reconcileNotificationReceipts({ now, limit: batch })
    result.projectedReceipts = receipts.projected
  } catch {
    result.errors += 1
  }

  // 3. Stale sends — intents stuck `sending` past grace. Recover from the
  //    job's evidence (project its current status), never re-send blindly.
  const stale = await listStaleSendingIntents(now - STALE_SENDING_GRACE_MS)
  for (const intent of stale.slice(0, batch)) {
    try {
      if (!intent.outboundJobId) {
        // A webhook intent carries no outbound job — a stale `sending` here
        // means a crash between the send and the attempt-append. The outcome
        // is genuinely uncertain (the platform may already have it), so per
        // the no-blind-retry rule it lands `delivery-unknown`, never re-queued.
        if (await transitionIntent(intent.id, "sending", { status: "delivery-unknown" })) {
          result.staleSendsRecovered += 1
        }
        continue
      }
      const job = await getDb().outboundQueue.get(intent.outboundJobId)
      if (job && (await projectOutboundJobReceipt(job, now))) {
        result.staleSendsRecovered += 1
      }
    } catch {
      result.errors += 1
    }
  }

  // 4. Due timers — quiet-release / digest-flush / escalation. Each timer
  //    fires its own effect; a fired timer is marked so it can't double-fire.
  //    Scoped to this account's prefix like the work sweep.
  const timers = (await listDueTimers(now)).filter((t) => t.scopeKey.startsWith(input.scopeKey))
  for (const timer of timers.slice(0, batch)) {
    try {
      await fireTimer(timer)
      result.timersFired += 1
    } catch {
      result.errors += 1
    }
  }

  return result
}

/**
 * Fire one due timer — dispatch on kind. A timer's effect is scoped: a
 * quiet-release re-queues the deferred fact's intent; a digest-flush marks
 * the bucket closed (the projector's next pass renders it); an escalation
 * re-arms or marks the fact needing-attention.
 */
async function fireTimer(timer: NotificationTimer): Promise<void> {
  const db = getDb()
  switch (timer.kind) {
    case "quiet-release": {
      // Release the deferred intent — flip `notBefore` off so it's sendable.
      if (timer.intentId) {
        await db.transaction("rw", db.notificationDeliveryIntents, async (txDb) => {
          const row = await txDb.notificationDeliveryIntents.get(timer.intentId!)
          if (row && row.status === "queued" && row.notBefore !== undefined) {
            await txDb.notificationDeliveryIntents.put({
              ...row,
              notBefore: undefined,
              updatedAt: Date.now(),
            })
          }
        })
      }
      break
    }
    case "digest-flush": {
      // The digest bucket's close boundary arrived — its members flush on the
      // next coordination pass. Marking the timer fired is the close signal.
      break
    }
    case "escalation":
    case "approval-expiry":
    case "retry":
    case "materiality-recheck": {
      // These timers' effects are consumed by the planner on the next pass —
      // firing just records that the deadline arrived.
      break
    }
  }
  await fireNotificationTimer(timer.id, timer.cancelToken)
}
