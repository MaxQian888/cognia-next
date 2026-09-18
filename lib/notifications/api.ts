// Notification V2 public API — the operator/producer facade.
//
// Two emission shapes converge here:
//   • Run-event facts — projected by the delivery worker (coordinator), which
//     also emits the center record. Producers never call this for journal
//     events; touching `notificationProjectionWork` in the journal's own
//     commit is the whole wake path.
//   • Manual / system facts — `emitNotification`, the commit-first entry a
//     caller uses for a one-off governed send (a scheduler reminder, a system
//     alert) that isn't journal-sourced but must ride the same durable
//     delivery + policy pipeline.
//
// Everything else is read/manage surface: diagnostics over intents+attempts,
// operator retry/cancel, and the target/subscription CRUD the settings UI
// binds to. No function here re-implements routing — they all delegate to the
// planner, the disclosure renderer, and the governed/webhook persist lanes.

import { nanoid } from "nanoid"
import { getDb } from "@/lib/db/schema"
import { resolvePreferences } from "./preferences"
import { useSettingsStore } from "@/stores/settings"
import { notificationPolicyContext } from "./policy/context"
import { resolveNotificationScope, scopeKeyFor, type NotificationScopeHint } from "./scope"
import { resolveNotificationPlan } from "./policy/resolver"
import {
  prepareGovernedNotificationDelivery,
  persistGovernedNotificationInsideTransaction,
  NotificationDeliveryRejection,
} from "./delivery/governed"
import {
  persistWebhookIntentInsideTransaction,
  prepareWebhookNotificationDelivery,
} from "./delivery/webhook-sender"
import { renderFactForTarget, type DerivedNotificationFact } from "./delivery/facts"
import { operationKeyFor } from "./delivery/coordinator"
import { foldIntoDigest } from "./policy/aggregation"
import { getNotificationTarget } from "@/lib/db/notification-targets"
import {
  getDeliveryIntent,
  listAttemptsForIntent,
  listIntentsForLogicalKey,
  listIntentsForRun,
  cancelIntent,
  transitionIntent,
  type NotificationDeliveryIntent,
  type NotificationDeliveryAttempt,
} from "@/lib/db/notification-delivery"
import type {
  NotificationDecision,
  NotificationCategory,
  NotificationPurpose,
} from "@/types/notifications/decision"
import type { NotificationLevel } from "@/types/notifications"
import type { NotificationRenderedPayload } from "@/types/notifications/result"

// ── Emit ────────────────────────────────────────────────────────────────────

export interface EmitNotificationInput {
  /** Stable fact identity — `{kind}:{id}`; generated when omitted. */
  logicalKey?: string
  category: NotificationCategory
  purpose: NotificationPurpose
  level: NotificationLevel
  /** Producer subsystem label (matches `NotificationSource`). */
  source: string
  title: string
  body?: string
  /** The run this fact belongs to, for `run`-bound subscriptions. */
  runId?: string
  /** The principal the fact is for (defaults to scope account). */
  principalId?: string
  /** Semantic material hash — suppress-if-unchanged input. */
  materialHash?: string
  /** Absolute validity deadline. */
  validUntil?: number
  /** The classification the producer stamped (target clipping reads this). */
  maxClassification?: DerivedNotificationFact["maxClassification"]
  /** Optional scope hint — resolves the authorization domain. */
  scopeHint?: NotificationScopeHint
  /** Idempotency for the WHOLE emit — a retry of this key collapses. */
  operationKey?: string
  now?: number
}

export interface EmitNotificationResult {
  factKey: string
  /** The planner's overall outcome for the fact. */
  outcome: NotificationDecision["outcome"]
  /** Intent ids committed (external targets). */
  intentIds: string[]
  /** The center record id, when the in-app inbox got one. */
  centerRecordId?: string
}

/**
 * Commit-first emit for a non-journal fact. Resolves the scope, mints the
 * durable center record (the always-on inbox), plans external routes, and
 * persists the governed/webhook intents in ONE transaction — so the fact and
 * its sends land atomically. Returns the committed intent ids.
 *
 * External sends go out through the delivery worker's next reconcile/sweep;
 * this function only ever COMMITS (it never performs a platform call).
 */
export async function emitNotification(
  input: EmitNotificationInput
): Promise<EmitNotificationResult> {
  const now = input.now ?? Date.now()
  const factKey = input.logicalKey ?? `manual:${nanoid()}`
  const scope = await resolveNotificationScope(input.scopeHint)
  const scopeKey = scopeKeyFor(scope)
  const prefs = resolvePreferences(useSettingsStore.getState().settings?.notificationPreferences)
  const policy = notificationPolicyContext(prefs)

  // The derived-fact shape the disclosure renderer + planner consume.
  const derived: DerivedNotificationFact = {
    fact: {
      factKey,
      category: input.category,
      purpose: input.purpose,
      level: input.level,
      source: input.source,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.principalId ? { principalId: input.principalId } : {}),
      ...(input.materialHash ? { materialHash: input.materialHash } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(input.maxClassification ? { maxClassification: input.maxClassification } : {}),
    },
    title: input.title,
    body: input.body ?? "",
    maxClassification: input.maxClassification ?? "internal",
  }

  // Center record — the always-on inbox (existing ADR-0042 funnel). The real
  // `notify()` is imported lazily so this module keeps no static sonner/Tauri
  // edge; a center failure never blocks the durable external commit.
  let centerRecordId: string | undefined
  try {
    const { notify } = await import("./runtime")
    centerRecordId = await notify({
      source: (input.source as never) ?? "system",
      level: input.level,
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      dedupeKey: factKey,
      ...(input.runId
        ? {
            groupKey: input.runId,
            href: `/agent-runs?run=${encodeURIComponent(input.runId)}`,
            sourceRef: { kind: "run", id: input.runId },
          }
        : {}),
      logicalKey: factKey,
      category: input.category,
      directed: input.purpose === "approval-request",
      ...(input.operationKey ? { operationKey: input.operationKey } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(input.scopeHint ? { scopeHint: input.scopeHint } : {}),
    })
    if (centerRecordId) derived.fact.notificationId = centerRecordId
  } catch {
    /* inbox best-effort */
  }

  // Plan + commit external routes.
  const priorIntents = await listIntentsForLogicalKey(factKey)
  const decision = await resolveNotificationPlan({
    fact: derived.fact,
    scopeKey,
    policy,
    priorIntents,
    now,
  })

  const intentIds = await commitFactRoutes({
    derived,
    decision,
    scopeKey,
    policyVersion: policy.policyVersion,
    baseOperationKey: input.operationKey,
    now,
  })

  return {
    factKey,
    outcome: decision.outcome,
    intentIds,
    ...(centerRecordId ? { centerRecordId } : {}),
  }
}

/**
 * Shared route-commit used by `emitNotification` and any future non-journal
 * producer. Prepares each sendable route transaction-externally, folds digests
 * outside the send transaction, then commits every intent in ONE `rw` tx.
 * Returns the committed intent ids (a route denied at commit-time is skipped,
 * never silently sent).
 */
export async function commitFactRoutes(input: {
  derived: DerivedNotificationFact
  decision: NotificationDecision
  scopeKey: string
  policyVersion: number
  /** Caller-supplied op-key seed — the emit's own idempotency key. */
  baseOperationKey?: string
  now: number
}): Promise<string[]> {
  const { derived, decision, scopeKey, now } = input
  const db = getDb()

  const prepared: {
    route: (typeof decision.routes)[number]
    governed?: Awaited<ReturnType<typeof prepareGovernedNotificationDelivery>>
    webhook?: Awaited<ReturnType<typeof prepareWebhookNotificationDelivery>>
  }[] = []

  for (const route of decision.routes) {
    if (route.kind === "notified" || route.kind === "deferred") {
      const target = await getNotificationTarget(route.targetId)
      if (!target) continue
      const payload = renderFactForTarget({
        derived,
        // The route's narrowed (route ∩ target) ceiling, not the target's
        // wider profile — a public-capped subscription stays counts-only.
        profileId: route.effectiveProfileId ?? target.disclosureProfileId,
      })
      try {
        if (target.address.kind === "feishu-webhook") {
          const webhook = await prepareWebhookNotificationDelivery({
            target,
            payload,
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
            policyVersion: input.policyVersion,
            ...(route.deferredUntil !== undefined ? { notBefore: route.deferredUntil } : {}),
          })
          prepared.push({ route, webhook })
        } else {
          const g = await prepareGovernedNotificationDelivery({
            targetId: route.targetId,
            payload,
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
            policyVersion: input.policyVersion,
            ...(route.deferredUntil !== undefined ? { notBefore: route.deferredUntil } : {}),
          })
          prepared.push({ route, governed: g })
        }
      } catch (err) {
        if (err instanceof NotificationDeliveryRejection) continue
        throw err
      }
    } else if (route.kind === "digest") {
      prepared.push({ route })
    }
  }

  for (const { route } of prepared.filter((p) => p.route.kind === "digest")) {
    if (route.aggregateKey) {
      await foldIntoDigest({
        fact: {
          ...derived.fact,
          notificationId: derived.fact.notificationId ?? derived.fact.factKey,
        },
        scopeKey,
        aggregateKey: route.aggregateKey,
        now,
      })
    }
  }

  const sendable = prepared.filter((p) => p.governed !== undefined || p.webhook !== undefined)
  if (sendable.length === 0) return []
  return db.transaction(
    "rw",
    [
      db.notificationDeliveryIntents,
      db.notificationTargets,
      db.notificationSubscriptions,
      db.outboundQueue,
    ],
    async () => {
      const ids: string[] = []
      for (const { governed, webhook } of sendable) {
        if (governed) {
          const { intentId } = await persistGovernedNotificationInsideTransaction(db, governed)
          if (intentId) ids.push(intentId)
        } else if (webhook) {
          const id = await persistWebhookIntentInsideTransaction(db, webhook)
          if (id) ids.push(id)
        }
      }
      return ids
    }
  )
}

// ── Preview ─────────────────────────────────────────────────────────────────

/**
 * Dry-run the planner for a fact — returns the closed decision + the rendered
 * per-target payloads WITHOUT persisting any intent or center record. The
 * settings "test notification" path uses this to show what WOULD send where.
 */
export async function previewNotification(input: EmitNotificationInput): Promise<{
  decision: NotificationDecision
  payloads: { targetId: string; payload: NotificationRenderedPayload }[]
}> {
  const now = input.now ?? Date.now()
  const scope = await resolveNotificationScope(input.scopeHint)
  const scopeKey = scopeKeyFor(scope)
  const prefs = resolvePreferences(useSettingsStore.getState().settings?.notificationPreferences)
  const policy = notificationPolicyContext(prefs)
  const derived: DerivedNotificationFact = {
    fact: {
      factKey: input.logicalKey ?? `preview:${nanoid()}`,
      category: input.category,
      purpose: input.purpose,
      level: input.level,
      source: input.source,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.materialHash ? { materialHash: input.materialHash } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(input.maxClassification ? { maxClassification: input.maxClassification } : {}),
    },
    title: input.title,
    body: input.body ?? "",
    maxClassification: input.maxClassification ?? "internal",
  }
  const priorIntents = await listIntentsForLogicalKey(derived.fact.factKey)
  const decision = await resolveNotificationPlan({
    fact: derived.fact,
    scopeKey,
    policy,
    priorIntents,
    now,
  })
  const payloads: { targetId: string; payload: NotificationRenderedPayload }[] = []
  for (const route of decision.routes) {
    if (route.kind !== "notified" && route.kind !== "deferred") continue
    const target = await getNotificationTarget(route.targetId)
    if (!target) continue
    payloads.push({
      targetId: route.targetId,
      payload: renderFactForTarget({
        derived,
        profileId: route.effectiveProfileId ?? target.disclosureProfileId,
      }),
    })
  }
  return { decision, payloads }
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

export interface NotificationDeliveryDetail {
  intent: NotificationDeliveryIntent
  attempts: NotificationDeliveryAttempt[]
}

/** All intents for one fact's logical key — the diagnostics list. */
export async function listNotificationDeliveries(
  logicalKey: string
): Promise<NotificationDeliveryIntent[]> {
  return listIntentsForLogicalKey(logicalKey)
}

/** All intents serving one run — the run-detail Notifications tab's data. */
export async function listNotificationDeliveriesForRun(
  runId: string
): Promise<NotificationDeliveryIntent[]> {
  return listIntentsForRun(runId)
}

/** One intent + its append-only attempt history. */
export async function getNotificationDeliveryDetail(
  intentId: string
): Promise<NotificationDeliveryDetail | undefined> {
  const intent = await getDeliveryIntent(intentId)
  if (!intent) return undefined
  return { intent, attempts: await listAttemptsForIntent(intentId) }
}

// ── Operator actions ────────────────────────────────────────────────────────

/**
 * Operator retry — re-queue a terminal intent (`failed`, `rejected`,
 * `delivery-unknown`) for another send pass. Deliberately NOT a re-send of a
 * `sending`/`accepted` intent (uncertain delivery is never blindly retried);
 * the returned intent is the same row flipped back to `queued` so the next
 * sweep picks it up under a fresh attempt index.
 */
export async function retryNotificationDelivery(
  intentId: string
): Promise<NotificationDeliveryIntent | undefined> {
  return transitionIntent(intentId, ["failed", "rejected", "delivery-unknown"], {
    status: "queued",
    nextAttemptAt: undefined,
    updatedAt: Date.now(),
  })
}

/**
 * Operator cancel — a `prepared`/`queued`/`sending` intent that hasn't yet
 * committed to a platform is cancelled. Late platform receipts still land as
 * append-only attempts (evidence is never lost).
 */
export async function cancelNotificationDelivery(
  intentId: string
): Promise<NotificationDeliveryIntent | undefined> {
  return cancelIntent(intentId)
}

// ── Management re-exports (settings UI binds here) ──────────────────────────
export {
  upsertNotificationTarget,
  getNotificationTarget,
  listNotificationTargets,
  deleteNotificationTarget,
} from "@/lib/db/notification-targets"
export {
  upsertNotificationSubscription,
  getNotificationSubscription,
  listNotificationSubscriptions,
  deleteNotificationSubscription,
  listSubscriptionsForTarget,
} from "@/lib/db/notification-subscriptions"
