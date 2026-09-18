// Notification V2 projection coordinator — the per-work-row orchestrator.
//
// This is the heart of the reliable-commit loop. For ONE claimed
// `notificationProjectionWork` row it consumes the run's event delta since
// `processedRunSeq` (and result revisions since `processedResultRevision`),
// derives each notification fact, plans its external delivery, and commits
// the governed intents + the cursor advance in ONE Dexie transaction per
// event — so the "we consumed up to seq N" fact and the sends it produced
// are atomic. A crash between them leaves neither half; a missed wake is
// recovered by the reconciler's `listDueProjectionWork` sweep.
//
// The split honors the design's transaction boundary:
//   • PLAN   — transaction-external. Read run/events/targets/subscriptions,
//              derive facts, run the pure planner, prepare deliveries. No
//              Dexie writes, no platform calls.
//   • COMMIT — transaction-internal. In ONE `rw` transaction per event:
//              revalidate versions, persist intents + outbound jobs, write
//              policy state / timers, advance the cursor. CAS-guarded on the
//              lease + generation; a moved cursor ⇒ replan, not a stale send.
//
// Per the design, batch progress halts at the first failing event — the
// cursor never skips a failed event (no "advance past the hole").

import { getDb } from "@/lib/db/schema"
import type { ExecutionRun, RunEvent } from "@/types/execution/run"
import type { NotificationProjectionWork } from "@/types/notifications/delivery"
import type { NotificationPolicyContext } from "@/types/notifications/decision"
import { getExecutionRun, listExecutionRunEvents } from "@/lib/db/execution-runs"
import { getLatestRunResultSummary } from "@/lib/db/run-result-summaries"
import {
  commitProjectionCursorInsideTransaction,
  blockProjectionWork,
} from "@/lib/db/notification-projection-work"
import { getNotificationTarget } from "@/lib/db/notification-targets"
import { resolveNotificationPlan } from "../policy/resolver"
import { deriveFactFromRunEvent, renderFactForTarget, type DerivedNotificationFact } from "./facts"
import {
  prepareGovernedNotificationDelivery,
  persistGovernedNotificationInsideTransaction,
  NotificationDeliveryRejection,
} from "./governed"
import {
  persistWebhookIntentInsideTransaction,
  prepareWebhookNotificationDelivery,
} from "./webhook-sender"
import { listIntentsForLogicalKey } from "@/lib/db/notification-delivery"
import { foldIntoDigest } from "../policy/aggregation"
import type { NotificationRouteDecision } from "@/types/notifications/decision"

/** Retry backoff for a blocked work row — bounded exponential. */
function retryBackoffMs(retryCount: number): number {
  const base = 1_000
  const cap = 5 * 60 * 1000
  return Math.min(cap, base * Math.pow(2, retryCount)) + Math.floor(Math.random() * 250)
}

export interface CoordinateResult {
  /** Whether the work row is now fully consumed. */
  done: boolean
  /** How many events were projected this pass. */
  processedEvents: number
  /** How many governed intents were committed. */
  intentsCommitted: number
  /** Set when the work was blocked (retry scheduled). */
  blocked?: { errorCode: string; retryAt: number }
}

/**
 * Best-effort center-record emitter — the in-app notification center is the
 * always-on inbox, so EVERY derived fact lands a record there via the existing
 * ADR-0042 `notify()` funnel (which self-gates toast/os/push on quiet hours).
 * External durable targets are what the planner routes; the center is
 * orthogonal. Injected so the coordinator keeps no Dexie/sonner/Tauri edge —
 * the worker wires it to the real `notify()`. Emitted BEFORE the commit so a
 * crash-retry dedupes on the factKey.
 */
export type EmitCenterRecord = (input: {
  derived: DerivedNotificationFact
  run: ExecutionRun
}) => void | Promise<void>

/**
 * Process ONE claimed work row. `work` is the row returned by
 * `claimProjectionWork` — the coordinator trusts its lease + generation and
 * re-verifies both inside each commit. On any per-event failure it blocks
 * the row (retry scheduled) and stops; the cursor never skips the hole.
 */
export async function coordinateProjectionWork(input: {
  work: NotificationProjectionWork
  policy: NotificationPolicyContext
  /** Lease owner identity — must match `work.leaseOwner`. */
  leaseOwner: string
  /** Optional in-app center emitter — see `EmitCenterRecord`. */
  emitCenter?: EmitCenterRecord
  now?: number
}): Promise<CoordinateResult> {
  const { work, leaseOwner } = input
  const now = input.now ?? Date.now()
  const subjectKey = work.subjectKey
  const runId = work.runId
  if (!runId) {
    // A non-run subject the projector doesn't yet serve — leave it for the
    // reconciler rather than burn retries on an unknown subject kind.
    return { done: false, processedEvents: 0, intentsCommitted: 0 }
  }

  const run = await getExecutionRun(runId)
  if (!run) {
    // The run vanished (retention). Nothing to project — advance to done.
    await commitDone(subjectKey, work, leaseOwner)
    return { done: true, processedEvents: 0, intentsCommitted: 0 }
  }

  // ── PLAN phase (transaction-external) ────────────────────────────────────
  const events = (await listExecutionRunEvents(runId)).filter(
    (e) => e.seq > work.processedRunSeq && e.seq <= work.desiredRunSeq
  )
  const resultSummary =
    work.desiredResultRevision > work.processedResultRevision
      ? await getLatestRunResultSummary(runId)
      : undefined

  let processedEvents = 0
  let intentsCommitted = 0
  let cursor = work.processedRunSeq

  // Process events in seq order; each event's sends + cursor advance commit
  // atomically. A failure stops the batch — the cursor stays at the last
  // contiguous success and the row is blocked for retry.
  for (const event of events) {
    try {
      const committed = await commitEventDelivery({
        run,
        event,
        work,
        policy: input.policy,
        leaseOwner,
        emitCenter: input.emitCenter,
        cursorSeq: event.seq,
        now,
      })
      if (committed === false) {
        // CAS lost — the cursor/lease moved under us; replan from scratch.
        return { done: false, processedEvents, intentsCommitted }
      }
      intentsCommitted += committed
      cursor = event.seq
      processedEvents += 1
    } catch (err) {
      const code = err instanceof NotificationDeliveryRejection ? err.code : "projection-error"
      const retryAt = now + retryBackoffMs(work.retryCount)
      await blockProjectionWork(subjectKey, leaseOwner, code, retryAt)
      return {
        done: false,
        processedEvents,
        intentsCommitted,
        blocked: { errorCode: code, retryAt },
      }
    }
  }

  // Result revision — a post-terminal summary is its own projection unit.
  if (resultSummary) {
    // The result-summary intent is planned separately (T3 builder wires it);
    // for now advance the result cursor once events are consumed.
    await advanceResultCursor(subjectKey, work, leaseOwner, resultSummary.revision)
  }

  const caughtUp =
    cursor >= work.desiredRunSeq &&
    (resultSummary ? true : work.processedResultRevision >= work.desiredResultRevision)
  return { done: caughtUp, processedEvents, intentsCommitted }
}

async function commitDone(
  subjectKey: string,
  work: NotificationProjectionWork,
  leaseOwner: string
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.notificationProjectionWork, async () => {
    await commitProjectionCursorInsideTransaction(db, subjectKey, {
      generation: work.generation,
      leaseOwner,
      processedRunSeq: work.desiredRunSeq,
      processedResultRevision: work.desiredResultRevision,
    })
  })
}

async function advanceResultCursor(
  subjectKey: string,
  work: NotificationProjectionWork,
  leaseOwner: string,
  revision: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.notificationProjectionWork, async () => {
    await commitProjectionCursorInsideTransaction(db, subjectKey, {
      generation: work.generation,
      leaseOwner,
      processedRunSeq: work.desiredRunSeq,
      processedResultRevision: revision,
    })
  })
}

/**
 * Plan + commit ONE event's external deliveries in a single transaction.
 * Returns the number of intents committed, or `false` when the cursor CAS
 * failed (the caller replans).
 */
async function commitEventDelivery(input: {
  run: ExecutionRun
  event: RunEvent
  work: NotificationProjectionWork
  policy: NotificationPolicyContext
  leaseOwner: string
  emitCenter?: EmitCenterRecord
  cursorSeq: number
  now: number
}): Promise<number | false> {
  const { run, event, work, policy, leaseOwner, now } = input
  const derived = deriveFactFromRunEvent(run, event)
  const db = getDb()

  // No notifiable signal — just advance the cursor past it.
  if (!derived) {
    return db.transaction("rw", db.notificationProjectionWork, async () => {
      const ok = await commitProjectionCursorInsideTransaction(db, work.subjectKey, {
        generation: work.generation,
        leaseOwner,
        processedRunSeq: input.cursorSeq,
        processedResultRevision: work.processedResultRevision,
      })
      return ok ? 0 : false
    })
  }

  // In-app center record — best-effort, BEFORE the commit so a crash-retry
  // dedupes on the factKey. A center failure must never block external
  // delivery or the cursor advance, so it's swallowed here.
  if (input.emitCenter) {
    try {
      await input.emitCenter({ derived, run })
    } catch {
      /* inbox best-effort — external delivery is the durable guarantee */
    }
  }

  // Plan — transaction-external. Resolves subscriptions + targets, runs the
  // pure planner, returns the closed decision. Run facts key their dedupe /
  // materiality baseline on `logicalKey` (no center NotificationRecord yet).
  const priorIntents = await listIntentsForLogicalKey(derived.fact.factKey)
  const decision = await resolveNotificationPlan({
    fact: derived.fact,
    scopeKey: work.scopeKey,
    policy,
    priorIntents,
    now,
  })

  // Prepare every sendable route — transaction-external prepare freezes the
  // clipped payload + the operation key. Webhook targets route through the
  // dedicated executor, not the governed outbound queue, so they build a
  // webhook intent spec instead of a governed `PreparedNotificationDelivery`.
  const preparedRoutes: {
    route: NotificationRouteDecision
    prepared?: Awaited<ReturnType<typeof prepareGovernedNotificationDelivery>>
    webhook?: Awaited<ReturnType<typeof prepareWebhookNotificationDelivery>>
  }[] = []
  for (const route of decision.routes) {
    if (route.kind === "notified" || route.kind === "deferred") {
      const target = await getNotificationTarget(route.targetId)
      if (!target) continue
      const clipped = renderFactForTarget({
        derived,
        // The route's narrowed (route ∩ target) ceiling, not the target's
        // wider profile — a public-capped subscription stays counts-only.
        profileId: route.effectiveProfileId ?? target.disclosureProfileId,
      })
      try {
        if (target.address.kind === "feishu-webhook") {
          const webhook = await prepareWebhookNotificationDelivery({
            target,
            payload: clipped,
            purpose: derived.fact.purpose,
            category: derived.fact.category,
            operationKey: operationKeyFor(
              derived.fact.factKey,
              route.targetId,
              derived.fact.purpose
            ),
            logicalKey: derived.fact.factKey,
            subscriptionId: route.subscriptionId,
            decisionRevision: decision.revision,
            policyVersion: policy.policyVersion,
            ...(route.deferredUntil !== undefined ? { notBefore: route.deferredUntil } : {}),
          })
          preparedRoutes.push({ route, webhook })
        } else {
          const prepared = await prepareGovernedNotificationDelivery({
            targetId: route.targetId,
            payload: clipped,
            purpose: derived.fact.purpose,
            category: derived.fact.category,
            operationKey: operationKeyFor(
              derived.fact.factKey,
              route.targetId,
              derived.fact.purpose
            ),
            logicalKey: derived.fact.factKey,
            subscriptionId: route.subscriptionId,
            decisionRevision: decision.revision,
            policyVersion: policy.policyVersion,
            ...(route.deferredUntil !== undefined ? { notBefore: route.deferredUntil } : {}),
          })
          preparedRoutes.push({ route, prepared })
        }
      } catch (err) {
        if (err instanceof NotificationDeliveryRejection) continue
        throw err
      }
    } else if (route.kind === "digest") {
      preparedRoutes.push({ route })
    }
  }

  // Digest folds happen outside the send transaction (member row first).
  const digestRoutes = preparedRoutes.filter((r) => r.route.kind === "digest")
  for (const { route } of digestRoutes) {
    if (route.aggregateKey) {
      await foldIntoDigest({
        fact: {
          ...derived.fact,
          notificationId: derived.fact.notificationId ?? derived.fact.factKey,
        },
        scopeKey: work.scopeKey,
        aggregateKey: route.aggregateKey,
        now,
      })
    }
  }

  // COMMIT — one transaction: the cursor advance + every governed intent +
  // every webhook intent. Webhook intents land `prepared` (no outbound job);
  // the webhook sender pass drains them on the next tick.
  const sendable = preparedRoutes.filter((r) => r.prepared !== undefined || r.webhook !== undefined)
  return db.transaction(
    "rw",
    [
      db.notificationProjectionWork,
      db.notificationDeliveryIntents,
      db.notificationTargets,
      db.notificationSubscriptions,
      db.outboundQueue,
    ],
    async () => {
      let committed = 0
      for (const { prepared, webhook } of sendable) {
        if (prepared) {
          const { intentId } = await persistGovernedNotificationInsideTransaction(db, prepared)
          if (intentId) committed += 1
        } else if (webhook) {
          await persistWebhookIntentInsideTransaction(db, webhook)
          committed += 1
        }
      }
      const ok = await commitProjectionCursorInsideTransaction(db, work.subjectKey, {
        generation: work.generation,
        leaseOwner,
        processedRunSeq: input.cursorSeq,
        processedResultRevision: work.processedResultRevision,
      })
      if (!ok) return false
      return committed
    }
  )
}

/** The stable operation key for one (fact, target, purpose) delivery op. */
export function operationKeyFor(factKey: string, targetId: string, purpose: string): string {
  return `n:${factKey}:${targetId}:${purpose}`
}
