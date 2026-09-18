// Notification V2 governed delivery — the transaction-safe split.
//
// The existing `enqueueOutbound()`/`enqueueOutboundMany()` run inside
// `Dexie.ignoreTransaction()` so they can NEVER participate in a caller's
// commit. V2 needs the opposite: the durable notification intent AND the
// outbound job must land in the SAME transaction as the fact commit, or a
// crash between them leaves an intent with no send (or a send with no
// intent). So delivery is split into two phases:
//
//   prepareGovernedNotificationDelivery      — transaction-EXTERNAL.
//     Resolves the target, validates source/consent, renders + redacts the
//     payload, freezes the scope and the content hash. No platform calls, no
//     Dexie writes. Everything the commit later trusts is decided here.
//
//   persistGovernedNotificationInsideTransaction — transaction-INTERNAL.
//     Revalidates the target/subscription VERSIONS (they may have moved
//     between prepare and commit), enforces the operation's uniqueness,
//     allocates the per-conversation orderSeq, writes the outbound job, and
//     links it to the delivery intent — all inside the caller's transaction.
//
// `ConnectorDeliveryGateway` stays the business boundary: callers use the
// gateway's prepare path, and the runner still sends through the adapter.
// Nothing here calls a platform `.send()` — persistence only.

import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { CogniaDB } from "@/lib/db/schema"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { scopeKeyOf } from "@/types/notifications/scope"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"
import type { NotificationRenderedPayload } from "@/types/notifications/result"
import type { NotificationPurpose, NotificationCategory } from "@/types/notifications/decision"
import { getNotificationTarget } from "@/lib/db/notification-targets"
import { getNotificationSubscription } from "@/lib/db/notification-subscriptions"

/** What the prepare phase freezes — everything the commit trusts. */
export interface PreparedNotificationDelivery {
  /** The sendable outbound payload (request + routing identity). */
  adapterId: string
  conversationKey: string
  request: OutboundRequest
  /**
   * The delivery-intent fields the commit persists, minus the ids/timestamps
   * the transaction fills. `outboundJobId` is linked at commit time.
   */
  intent: Omit<
    NotificationDeliveryIntent,
    "id" | "createdAt" | "updatedAt" | "attemptCount" | "outboundJobId" | "status"
  >
  /** The operation-authority key stamped on BOTH rows (unique on each). */
  operationKey: string
  /** Versions the commit revalidates — moved versions ⇒ replan, don't send. */
  expectedTargetVersion: number
  expectedSubscriptionVersion?: number
}

export class NotificationDeliveryRejection extends Error {
  constructor(
    readonly code:
      | "target-missing"
      | "target-disabled"
      | "target-deleted"
      | "consent-not-granted"
      | "subscription-missing"
      | "subscription-disabled"
      | "target-version-moved"
      | "subscription-version-moved"
      | "pii-rejected"
      | "operation-key-conflict",
    message: string
  ) {
    super(message)
    this.name = "NotificationDeliveryRejection"
  }
}

/**
 * Transaction-EXTERNAL prepare. Validates + freezes everything; performs no
 * Dexie writes and no platform calls. Returns the prepared delivery the
 * commit phase persists atomically.
 *
 * `contentHash` is the semantic identity — the SAME operationKey with a
 * different contentHash is a rejected conflict (the operation is immutable;
 * a materially different payload must mint a NEW operation key).
 */
export async function prepareGovernedNotificationDelivery(input: {
  targetId: string
  payload: NotificationRenderedPayload
  purpose: NotificationPurpose
  category: NotificationCategory
  operationKey: string
  notificationId?: string
  logicalKey?: string
  slotKey?: string
  publicationId?: string
  subscriptionId?: string
  decisionRevision?: number
  policyVersion?: number
  plannerVersion?: number
  /** Optional deferred/expiry constraints folded into the intent. */
  notBefore?: number
  expiresAt?: number
  maxAttempts?: number
  /** Optional reply anchor / thread / edit handle for the request. */
  replyToMessageId?: string
  threadId?: string
  editTargetMessageId?: string
  /** Extra request segments (a rendered card) — replaces the default text. */
  segments?: MessageSegment[]
  /** PII gate override for tests; defaults to the fail-closed deep scan. */
  piiGate?: (value: unknown) => boolean
}): Promise<PreparedNotificationDelivery> {
  const target = await getNotificationTarget(input.targetId)
  if (!target) throw new NotificationDeliveryRejection("target-missing", input.targetId)
  if (target.deletedAt !== undefined) {
    throw new NotificationDeliveryRejection("target-deleted", input.targetId)
  }
  if (!target.enabled) throw new NotificationDeliveryRejection("target-disabled", input.targetId)
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
    if (!subscription.targetIds.includes(input.targetId)) {
      throw new NotificationDeliveryRejection("consent-not-granted", "target-not-in-route")
    }
    expectedSubscriptionVersion = subscription.version
  }

  const piiGate = input.piiGate ?? hasNoLeakingPiiDeep
  const segments =
    input.segments ??
    ([
      { type: "text", text: `${input.payload.title}\n\n${input.payload.body}` },
    ] as MessageSegment[])
  if (!piiGate(segments)) {
    throw new NotificationDeliveryRejection("pii-rejected", input.operationKey)
  }

  if (target.address.kind !== "connector") {
    // One-way webhook targets do not ride the governed outbound queue — they
    // execute through the dedicated webhook executor. Preparing one here is
    // a caller bug (the planner should have routed it elsewhere).
    throw new NotificationDeliveryRejection("target-missing", "webhook-not-governed-queue")
  }
  const address = target.address
  const request: OutboundRequest = {
    conversationRef: address.deliveryTarget.conversationRef,
    deliveryTarget: address.deliveryTarget,
    segments,
    ...(input.replyToMessageId ? { replyTo: { messageId: input.replyToMessageId } } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.editTargetMessageId ? { editTargetMessageId: input.editTargetMessageId } : {}),
    metadata: { idempotencyKey: input.operationKey },
  }

  const conversationKey = address.conversationKey ?? address.deliveryTarget.address.conversationKey
  const intent: PreparedNotificationDelivery["intent"] = {
    scopeKey: scopeKeyOf(target.scope),
    scope: target.scope,
    ...(input.notificationId ? { notificationId: input.notificationId } : {}),
    ...(input.logicalKey ? { logicalKey: input.logicalKey } : {}),
    ...(input.publicationId ? { publicationId: input.publicationId } : {}),
    operationKey: input.operationKey,
    targetId: input.targetId,
    targetAddress: address,
    targetVersion: target.version,
    purpose: input.purpose,
    category: input.category,
    ...(input.slotKey ? { slotKey: input.slotKey } : {}),
    ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
    ...(expectedSubscriptionVersion !== undefined
      ? { subscriptionVersion: expectedSubscriptionVersion }
      : {}),
    ...(input.decisionRevision !== undefined ? { decisionRevision: input.decisionRevision } : {}),
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
    maxAttempts: input.maxAttempts ?? 5,
    ...(input.plannerVersion !== undefined ? { plannerVersion: input.plannerVersion } : {}),
    ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
  }

  return {
    adapterId: address.adapterId,
    conversationKey,
    request,
    intent,
    operationKey: input.operationKey,
    expectedTargetVersion: target.version,
    ...(expectedSubscriptionVersion !== undefined ? { expectedSubscriptionVersion } : {}),
  }
}

/**
 * Transaction-INTERNAL persist. Runs inside the caller's transaction on the
 * transaction-bound `txDb`. Revalidates the versions frozen at prepare,
 * enforces operation uniqueness (the unique `operationKey` index on intents
 * + `notificationOperationKey` on the queue), allocates the per-conversation
 * `orderSeq`, writes the outbound job, then writes the intent linked to it.
 *
 * Returns `{ intentId, outboundJobId }`. A unique-index conflict on either
 * row throws `NotificationDeliveryRejection("operation-key-conflict")` —
 * callers treat it as "this operation is already persisted" (idempotent
 * re-entry), not a failure.
 */
export async function persistGovernedNotificationInsideTransaction(
  txDb: CogniaDB,
  prepared: PreparedNotificationDelivery
): Promise<{ intentId: string; outboundJobId: string }> {
  const now = Date.now()

  // 1. Revalidate the target version — a moved/deleted target between prepare
  //    and commit stops the send (the planner replans on the fresh version).
  const target = await txDb.notificationTargets.get(prepared.intent.targetId)
  if (!target || target.deletedAt !== undefined || !target.enabled) {
    throw new NotificationDeliveryRejection("target-version-moved", prepared.intent.targetId)
  }
  if (target.version !== prepared.expectedTargetVersion) {
    throw new NotificationDeliveryRejection("target-version-moved", prepared.intent.targetId)
  }
  if (prepared.expectedSubscriptionVersion !== undefined && prepared.intent.subscriptionId) {
    const sub = await txDb.notificationSubscriptions.get(prepared.intent.subscriptionId)
    if (!sub || sub.deletedAt !== undefined || !sub.enabled) {
      throw new NotificationDeliveryRejection(
        "subscription-version-moved",
        prepared.intent.subscriptionId
      )
    }
    if (sub.version !== prepared.expectedSubscriptionVersion) {
      throw new NotificationDeliveryRejection(
        "subscription-version-moved",
        prepared.intent.subscriptionId
      )
    }
  }

  // 2. Operation uniqueness — if an intent already carries this operationKey
  //    the operation is already persisted; return its ids rather than write a
  //    second send. The unique outbound index is the final backstop below.
  const existing = await txDb.notificationDeliveryIntents
    .where("operationKey")
    .equals(prepared.operationKey)
    .first()
  if (existing) {
    return { intentId: existing.id, outboundJobId: existing.outboundJobId ?? "" }
  }

  // 3. Allocate the per-conversation orderSeq inside the transaction — the
  //    same FIFO discipline `enqueueOutboundMany` uses, but transaction-bound.
  const newest = await txDb.outboundQueue
    .where("[conversationKey+orderSeq]")
    .between([prepared.conversationKey, -Infinity], [prepared.conversationKey, Infinity])
    .last()
  const orderSeq = (newest?.orderSeq ?? 0) + 1

  // 4. Write the outbound job — `source: "notification"` so the runner sends
  //    it but the receipt projects onto the intent, not a run presentation.
  const outboundJobId = `oqj_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const job: OutboundJobRow = {
    id: outboundJobId,
    adapterId: prepared.adapterId,
    ...(prepared.intent.scope.workspaceId ? { projectId: prepared.intent.scope.workspaceId } : {}),
    conversationKey: prepared.conversationKey,
    request: prepared.request,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    orderSeq,
    nextAttemptAt: prepared.intent.notBefore ?? now,
    idempotencyKey: prepared.operationKey,
    source: "notification",
    notificationOperationKey: prepared.operationKey,
  }
  try {
    await txDb.outboundQueue.add(job)
  } catch (err) {
    throw constraintToRejection(err)
  }

  // 5. Write the intent, linked to the job — the durable intent the receipt
  //    reconciler and delivery diagnostics read.
  const intentId = `ndi_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const intent: NotificationDeliveryIntent = {
    ...prepared.intent,
    id: intentId,
    status: "queued",
    outboundJobId,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await txDb.notificationDeliveryIntents.add(intent)
  } catch (err) {
    throw constraintToRejection(err)
  }

  return { intentId, outboundJobId }
}

function constraintToRejection(err: unknown): NotificationDeliveryRejection | Error {
  const name = err instanceof Error ? err.name : ""
  if (name === "ConstraintError" || name === "BulkError") {
    return new NotificationDeliveryRejection("operation-key-conflict", String(err))
  }
  return err instanceof Error ? err : new Error(String(err))
}
