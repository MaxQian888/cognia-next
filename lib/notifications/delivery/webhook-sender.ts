// Notification V2 webhook send pass — drains prepared webhook intents.
//
// A `feishu-webhook` intent is persisted WITHOUT an outbound job (webhooks
// don't ride the connector queue). This pass is the sender: it claims each
// eligible webhook intent, runs it through `deliverFeishuWebhook`, appends
// the attempt evidence, and transitions the intent — the same durability +
// recovery contract the connector lane gets via the outbound runner, owned
// here because webhooks are one-way and have no runner of their own.
//
// Recovery is identical in spirit: a crash between send and transition
// leaves the intent `sending`, which the reconciler's stale-send recovery
// re-evaluates — the executor's `timeout-unknown` semantics mean a maybe-
// sent webhook is NEVER blindly re-sent (the platform may have it already).

import { getDb, type CogniaDB } from "@/lib/db/schema"
import { nanoid } from "nanoid"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"
import type { NotificationTarget } from "@/types/notifications/target"
import type { NotificationRenderedPayload } from "@/types/notifications/result"
import type { NotificationCategory, NotificationPurpose } from "@/types/notifications/decision"
import { scopeKeyOf } from "@/types/notifications/scope"
import { getNotificationTarget } from "@/lib/db/notification-targets"
import { getNotificationSubscription } from "@/lib/db/notification-subscriptions"
import { appendDeliveryAttempt, transitionIntent } from "@/lib/db/notification-delivery"
import {
  deliverFeishuWebhook,
  type FeishuWebhookDeps,
  type FeishuWebhookResult,
} from "./feishu-webhook"
import { commitPublicationRender, getPublication } from "@/lib/db/notification-publications"
import { NotificationDeliveryRejection } from "./governed"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

/** Eligible webhook intents — `queued`/`prepared` with no outbound job. */
async function listPendingWebhookIntents(
  now: number,
  limit: number
): Promise<NotificationDeliveryIntent[]> {
  return getDb()
    .notificationDeliveryIntents.where("status")
    .anyOf("prepared", "queued")
    .filter((i) => {
      if (i.outboundJobId !== undefined) return false // connector lane owns these
      if (i.notBefore !== undefined && i.notBefore > now) return false
      if (i.expiresAt !== undefined && i.expiresAt <= now) return false
      if (i.nextAttemptAt !== undefined && i.nextAttemptAt > now) return false
      return true
    })
    .limit(limit)
    .toArray()
}

/**
 * Send eligible webhook intents, bounded to `limit`. Each send claims the
 * intent (`sending`), executes the webhook, appends the attempt, and lands
 * the intent on `accepted`/`failed`/`rejected`/`delivery-unknown` or back
 * on `queued` with backoff for a retryable outcome. Returns the counts.
 */
export async function sendPendingWebhookIntents(input: {
  deps: FeishuWebhookDeps
  now?: number
  limit?: number
}): Promise<{ sent: number; failed: number; retried: number; scanned: number }> {
  const now = input.now ?? Date.now()
  const limit = input.limit ?? 64
  const pending = await listPendingWebhookIntents(now, limit)
  let sent = 0
  let failed = 0
  let retried = 0

  for (const intent of pending) {
    const target = await getNotificationTarget(intent.targetId)
    if (!target || target.deletedAt !== undefined || !target.enabled) {
      await transitionIntent(intent.id, ["prepared", "queued"], { status: "cancelled" })
      continue
    }
    if (target.address.kind !== "feishu-webhook") continue
    if (target.version !== intent.targetVersion) {
      // The destination moved between plan and send — replan, don't send to
      // a stale address.
      await transitionIntent(intent.id, ["prepared", "queued"], { status: "superseded" })
      continue
    }

    // Claim — only one sender may transition queued → sending.
    const claimed = await transitionIntent(intent.id, ["prepared", "queued"], {
      status: "sending",
      lastAttemptAt: now,
    })
    if (!claimed) continue

    // A secret-resolution or transport fault inside the executor must not
    // escape — it would abort the whole batch AND wedge this claimed intent
    // in `sending`. A fault here means the send never reached the platform
    // (no blind re-send risk), so classify it `internal-error` and let the
    // retry/terminal logic below land the intent.
    const result = await deliverFeishuWebhook({
      target: target as NotificationTarget,
      payload: intent.payload,
      deps: input.deps,
    }).catch((): FeishuWebhookResult => ({ outcome: "internal-error", errorCode: "sender-fault" }))
    const outcome = result.outcome
    const startedAt = intent.lastAttemptAt ?? now

    // Append the attempt + land the intent. Retryable outcomes re-queue with
    // backoff; terminal ones close the intent.
    const terminal =
      outcome === "accepted"
        ? "accepted"
        : outcome === "timeout-unknown"
          ? "delivery-unknown"
          : outcome === "invalid-target" ||
              outcome === "auth-failed" ||
              outcome === "content-rejected"
            ? "rejected"
            : null
    const retryable =
      outcome === "network-error" || outcome === "rate-limited" || outcome === "internal-error"

    const db = getDb()
    await db.transaction(
      "rw",
      [db.notificationDeliveryIntents, db.notificationDeliveryAttempts],
      async () => {
        await appendDeliveryAttempt(
          {
            intentId: intent.id,
            outcome,
            ...(result.platformMessageId
              ? { receipt: { platformMessageId: result.platformMessageId } }
              : {}),
            ...(result.errorCode
              ? { errorCode: result.errorCode }
              : result.platformCode !== undefined
                ? { errorCode: `feishu-${result.platformCode}` }
                : {}),
            startedAt,
            outboundJobId: intent.id, // no outbound job — self-reference for the log
          },
          db
        )
        if (terminal) {
          await transitionIntent(intent.id, "sending", { status: terminal }, db)
        } else if (retryable && intent.attemptCount + 1 < intent.maxAttempts) {
          const backoff = Math.min(5 * 60 * 1000, 1000 * Math.pow(2, intent.attemptCount))
          await transitionIntent(
            intent.id,
            "sending",
            { status: "queued", nextAttemptAt: now + backoff },
            db
          )
        } else {
          // Out of retries, or a non-retryable outcome with no terminal map —
          // the send genuinely failed.
          await transitionIntent(intent.id, "sending", { status: "failed" }, db)
        }
      }
    )

    if (outcome === "accepted") {
      sent += 1
      if (intent.publicationId) {
        const pub = await getPublication(intent.publicationId)
        if (pub) {
          await commitPublicationRender(pub.id, pub.renderedRevision, {
            platformMessageId: result.platformMessageId,
            acceptedContentHash: intent.payload.contentHash,
          }).catch(() => undefined)
        }
      }
    } else if (terminal) {
      failed += 1
    } else {
      retried += 1
    }
  }
  return { sent, failed, retried, scanned: pending.length }
}

/** A frozen webhook delivery, ready to commit inside the caller's tx. */
export interface PreparedWebhookDelivery {
  target: NotificationTarget
  payload: NotificationRenderedPayload
  purpose: NotificationPurpose
  category: NotificationCategory
  operationKey: string
  logicalKey?: string
  notificationId?: string
  slotKey?: string
  publicationId?: string
  subscriptionId?: string
  decisionRevision?: number
  policyVersion?: number
  notBefore?: number
  expiresAt?: number
  /** Target version frozen at prepare — revalidated at commit. */
  expectedTargetVersion: number
  /** Subscription version frozen at prepare — revalidated at commit. */
  expectedSubscriptionVersion?: number
}

/**
 * Transaction-EXTERNAL prepare for the webhook lane — the mirror of
 * `prepareGovernedNotificationDelivery`. Validates the target + subscription,
 * freezes their versions, and runs the SAME PII gate the governed lane runs —
 * the most-external lane does not get a weaker content check. Performs no
 * Dexie writes and no platform calls; returns the prepared delivery the
 * commit phase persists atomically.
 */
export async function prepareWebhookNotificationDelivery(input: {
  target: NotificationTarget
  payload: NotificationRenderedPayload
  purpose: NotificationPurpose
  category: NotificationCategory
  operationKey: string
  logicalKey?: string
  notificationId?: string
  slotKey?: string
  publicationId?: string
  subscriptionId?: string
  decisionRevision?: number
  policyVersion?: number
  notBefore?: number
  expiresAt?: number
  /** Injectable for tests — defaults to the shared deep PII scan. */
  piiGate?: (value: unknown) => boolean
}): Promise<PreparedWebhookDelivery> {
  const { target } = input
  if (target.address.kind !== "feishu-webhook") {
    throw new NotificationDeliveryRejection("target-missing", "webhook-required")
  }
  if (target.deletedAt !== undefined) {
    throw new NotificationDeliveryRejection("target-deleted", target.id)
  }
  if (!target.enabled) {
    throw new NotificationDeliveryRejection("target-disabled", target.id)
  }
  if (target.consent.mode !== "proactive" && input.purpose !== "approval-request") {
    // `origin-reply` consent only authorizes answering a notification that
    // originated in this conversation — which is exactly an approval-request.
    throw new NotificationDeliveryRejection("consent-not-granted", target.consent.mode)
  }

  let expectedSubscriptionVersion: number | undefined
  if (input.subscriptionId) {
    const subscription = await getNotificationSubscription(input.subscriptionId)
    if (!subscription || subscription.deletedAt !== undefined) {
      throw new NotificationDeliveryRejection("subscription-missing", input.subscriptionId)
    }
    if (!subscription.enabled) {
      throw new NotificationDeliveryRejection("subscription-disabled", input.subscriptionId)
    }
    if (!subscription.targetIds.includes(target.id)) {
      throw new NotificationDeliveryRejection("consent-not-granted", "target-not-in-route")
    }
    expectedSubscriptionVersion = subscription.version
  }

  // PII gate — the rendered payload (title, body, action labels + refs) is
  // deep-scanned before it can ever reach the one-way webhook.
  const piiGate = input.piiGate ?? hasNoLeakingPiiDeep
  if (!piiGate(input.payload)) {
    throw new NotificationDeliveryRejection("pii-rejected", input.operationKey)
  }

  return {
    ...input,
    expectedTargetVersion: target.version,
    ...(expectedSubscriptionVersion !== undefined ? { expectedSubscriptionVersion } : {}),
  }
}

/**
 * Transaction-INTERNAL persist. Runs inside the caller's transaction on the
 * transaction-bound `txDb`. Unlike the governed connector path there's NO
 * outbound job — the webhook sender owns the send — so the intent lands
 * `prepared` with its frozen payload and the operationKey carries the
 * uniqueness guarantee (same operation ⇒ the unique index throws, which the
 * coordinator treats as already-persisted).
 *
 * Revalidates the target + subscription versions frozen at prepare — a moved
 * or revoked route between plan and commit stops the send (the planner
 * replans on the fresh version), so a disabled subscription can never land a
 * webhook intent it no longer authorizes.
 */
export async function persistWebhookIntentInsideTransaction(
  txDb: CogniaDB,
  input: PreparedWebhookDelivery
): Promise<string> {
  const now = Date.now()
  const { target } = input

  // Revalidate the versions frozen at prepare — the same commit-time check
  // the governed lane performs, so a route revoked between plan and commit
  // is denied here rather than silently landing.
  const liveTarget = await txDb.notificationTargets.get(target.id)
  if (!liveTarget || liveTarget.deletedAt !== undefined || !liveTarget.enabled) {
    throw new NotificationDeliveryRejection("target-version-moved", target.id)
  }
  if (liveTarget.version !== input.expectedTargetVersion) {
    throw new NotificationDeliveryRejection("target-version-moved", target.id)
  }
  if (input.expectedSubscriptionVersion !== undefined && input.subscriptionId) {
    const sub = await txDb.notificationSubscriptions.get(input.subscriptionId)
    if (!sub || sub.deletedAt !== undefined || !sub.enabled) {
      throw new NotificationDeliveryRejection("subscription-version-moved", input.subscriptionId)
    }
    if (sub.version !== input.expectedSubscriptionVersion) {
      throw new NotificationDeliveryRejection("subscription-version-moved", input.subscriptionId)
    }
  }

  const existing = await txDb.notificationDeliveryIntents
    .where("operationKey")
    .equals(input.operationKey)
    .first()
  if (existing) return existing.id
  const intent: NotificationDeliveryIntent = {
    id: `ndi_${now.toString(36)}_${nanoid(6)}`,
    scopeKey: scopeKeyOf(target.scope),
    scope: target.scope,
    ...(input.notificationId ? { notificationId: input.notificationId } : {}),
    ...(input.logicalKey ? { logicalKey: input.logicalKey } : {}),
    ...(input.publicationId ? { publicationId: input.publicationId } : {}),
    operationKey: input.operationKey,
    targetId: target.id,
    targetAddress: target.address,
    targetVersion: target.version,
    purpose: input.purpose,
    category: input.category,
    ...(input.slotKey ? { slotKey: input.slotKey } : {}),
    ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
    ...(input.expectedSubscriptionVersion !== undefined
      ? { subscriptionVersion: input.expectedSubscriptionVersion }
      : {}),
    ...(input.decisionRevision !== undefined ? { decisionRevision: input.decisionRevision } : {}),
    status: "prepared",
    payload: {
      title: input.payload.title,
      body: input.payload.body,
      level: input.payload.level,
      ...(input.payload.actions ? { actions: input.payload.actions } : {}),
      disclosureLevel: input.payload.disclosureLevel,
      clippedFactCount: input.payload.clippedFactCount,
      contentHash: input.payload.contentHash,
    },
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
    attemptCount: 0,
    maxAttempts: 5,
    ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await txDb.notificationDeliveryIntents.add(intent)
  return intent.id
}
