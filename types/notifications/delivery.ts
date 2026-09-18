// Notification V2 durable delivery + projection rows.
//
// Every row here is append-friendly and CAS-versioned: intents are the
// *intent* to perform one governed delivery operation, attempts are the
// append-only evidence of each actual send, timers are cancellable scheduled
// work, publications are the serialized external-message slots, and
// projection work rows are the durable dirty-marker the Run Journal touches.

import type { NotificationScope } from "./scope"
import type { NotificationCategory, NotificationPurpose } from "./decision"
import type { NotificationTargetAddress } from "./target"
import type { NotificationRenderedPayload } from "./result"

// ─── Delivery intents ────────────────────────────────────────────────────────

/**
 * Lifecycle of one delivery intent. `queued → sending → accepted` is the
 * happy path; `delivery-unknown` is a TERMINAL-BUT-UNVERIFIED state — the
 * outcome is genuinely unknown (timeout mid-send) and must never be folded
 * into "delivered" or silently retried as if fresh.
 */
export type NotificationIntentStatus =
  | "prepared" // written, not yet eligible to send
  | "queued" // eligible — the outbound job exists
  | "sending" // claimed by the governed runner
  | "accepted" // platform-acknowledged (receipt projected)
  | "rejected" // platform definitively refused
  | "failed" // exhausted retries, no acceptance
  | "delivery-unknown" // outcome unknown — visible forever until resolved
  | "superseded" // replaced by a newer intent for the same slot
  | "cancelled" // revoked before send (target/subscription removed, expiry)
  | "expired" // validity window passed while queued

/** One durable intent to perform ONE external delivery operation. */
export interface NotificationDeliveryIntent {
  id: string
  scopeKey: string
  scope: NotificationScope
  /** The notification fact this intent serves (NotificationRecord.id). */
  notificationId?: string
  /** The fact's stable logical key when known. */
  logicalKey?: string
  /** Which slot inside the publication this op fills. */
  publicationId?: string
  /**
   * The dedupe/authority key — `outboundQueue.notificationOperationKey`
   * carries the same value. Two intents with the same operationKey are the
   * SAME operation: the second persist attempt short-circuits.
   */
  operationKey: string
  /** The operation's semantic identity (slot addressing). */
  targetId: string
  /** Frozen address snapshot — resolved target at persist time. */
  targetAddress: NotificationTargetAddress
  /** The target row version the address was frozen from. */
  targetVersion: number
  purpose: NotificationPurpose
  category: NotificationCategory
  /**
   * Delivery slot key — `runId:purpose:addressFingerprint` for run-scoped
   * ops. One slot carries at most one live intent; a supersede closes the
   * old one first.
   */
  slotKey?: string
  /** The subscription (route) that authorized this intent, when any. */
  subscriptionId?: string
  subscriptionVersion?: number
  /** The decision this intent was minted from. */
  decisionRevision?: number
  status: NotificationIntentStatus
  /**
   * Frozen sendable payload — the post-disclosure rendered view, already
   * clipped to the target's ceiling. Typed as `NotificationRenderedPayload`
   * so the same shape flows from the clipper straight into the sendable
   * intent (the `clippedFactCount` "+N more" count rides along).
   */
  payload: NotificationRenderedPayload
  /** When the intent stops being valid (deferred approval expiry, etc.). */
  expiresAt?: number
  /** Earliest time it may send (deferred / quiet-hours release). */
  notBefore?: number
  /** The outboundQueue row id once persisted — the governed send handle. */
  outboundJobId?: string
  /** Retry bookkeeping — owned by the NOTIFICATION layer, never the driver. */
  attemptCount: number
  maxAttempts: number
  nextAttemptAt?: number
  lastAttemptAt?: number
  /** The planner that minted it — replay/debug. */
  plannerVersion?: number
  policyVersion?: number
  createdAt: number
  updatedAt: number
}

// ─── Delivery attempts (append-only) ─────────────────────────────────────────

/** What one actual send attempt concluded — including driver-internal retries. */
export type NotificationAttemptOutcome =
  | "accepted" // platform acknowledged
  | "rejected" // platform definitively refused
  | "network-error" // transport failure, retryable
  | "timeout-unknown" // timed out — outcome genuinely unknown
  | "rate-limited" // platform asked us to back off
  | "auth-failed" // credential rejected — not retryable without rotation
  | "invalid-target" // target no longer exists / not authorized
  | "content-rejected" // platform refused the payload
  | "cancelled" // never sent — revoked / superseded pre-send
  | "internal-error" // our own bug — retryable once

/** Append-only evidence of one actual send attempt. Never mutated. */
export interface NotificationDeliveryAttempt {
  id: string
  intentId: string
  /** Which attempt number the NOTIFICATION layer assigned (1-based). */
  attemptIndex: number
  /** Driver-internal sub-attempt (the driver may retry inside one call). */
  subAttempt?: number
  outcome: NotificationAttemptOutcome
  /** Platform receipt when accepted (message id / request id). */
  receipt?: {
    platformMessageId?: string
    platformRequestId?: string
    raw?: string // opaque platform payload hash, not the payload itself
  }
  /** Platform error detail — code, not the message body (may carry PII). */
  errorCode?: string
  errorClass?: string
  /** When the attempt started / concluded. */
  startedAt: number
  finishedAt: number
  /** The outboundQueue job id this attempt ran under. */
  outboundJobId?: string
  createdAt: number
}

// ─── Projection work ─────────────────────────────────────────────────────────

/**
 * The durable dirty-marker the Run Journal touches inside its own commit.
 * `desired*` is what the journal says must be projected; `processed*` is what
 * the projector has durably consumed. A run with `desired > processed` has
 * pending projection work — the reconciler sweeps these even when the wake
 * is lost.
 */
export interface NotificationProjectionWork {
  id: string
  scopeKey: string
  /**
   * The durable subject this row projects — `run:{runId}` for run-scoped
   * work. The unique index is on this so one subject carries exactly one
   * cursor; a run is simply the first subject kind.
   */
  subjectKey: string
  /** The run this work row projects (when the subject is a run). */
  runId?: string
  /** Highest run-event seq the journal has committed (monotonic). */
  desiredRunSeq: number
  /** Highest contiguous seq the projector has consumed. */
  processedRunSeq: number
  /** Latest immutable result-summary revision the journal recorded. */
  desiredResultRevision: number
  /** Latest result revision the projector has consumed. */
  processedResultRevision: number
  /**
   * Bump to force reprocessing of already-consumed events (policy change,
   * redaction upgrade). The projector CAS-checks it.
   */
  generation: number
  state: "pending" | "processing" | "blocked" | "done"
  /** Next time a blocked row becomes due — the reconciler's eligibility. */
  nextAttemptAt?: number
  /** Retry bookkeeping — blocked rows retry with backoff. */
  retryAt?: number
  retryCount: number
  /** Lease — a crashed projector's row is stealable after expiry. */
  leaseOwner?: string
  leaseExpiresAt?: number
  /** Last terminal error code (never the message — may carry PII). */
  lastErrorCode?: string
  /** The host epoch this work was created under — stale-epoch guard. */
  ownerEpoch?: number
  createdAt: number
  updatedAt: number
}

// ─── Publications ────────────────────────────────────────────────────────────

/**
 * One external message/card a notification owns — the serialized slot. Every
 * update to the same platform message is one new intent on the same
 * publication row; `renderedRevision` CAS-guards overwrites.
 */
export interface NotificationPublication {
  id: string
  scopeKey: string
  /** The fact this publication renders. */
  notificationId: string
  logicalKey?: string
  /** The external address slot it occupies. */
  targetId: string
  /** `runId:purpose:addressFingerprint` — same slot key as the intents. */
  slotKey: string
  purpose: NotificationPurpose
  /** The platform's message handle once accepted. */
  platformMessageId?: string
  /** Latest rendered content the platform accepted. */
  acceptedContentHash?: string
  /** Latest rendered revision — CAS guard for overwrites. */
  renderedRevision: number
  /** Whether the underlying run is still live (affects update semantics). */
  runTerminal: boolean
  state: "open" | "superseded" | "closed"
  createdAt: number
  updatedAt: number
}

// ─── Timers ──────────────────────────────────────────────────────────────────

/** Cancellable scheduled notification work — quiet release, digest flush… */
export type NotificationTimerKind =
  | "quiet-release" // release a deferred fact when quiet hours end
  | "digest-flush" // flush one aggregate bucket at close
  | "escalation" // re-notify when a fact stays unread
  | "retry" // delivery-intent retry backoff
  | "approval-expiry" // auto-resolve a deferred approval
  | "materiality-recheck" // re-evaluate suppress-if-unchanged

export interface NotificationTimer {
  id: string
  scopeKey: string
  kind: NotificationTimerKind
  /** The fact / intent / aggregate this timer serves. */
  factKey?: string
  intentId?: string
  aggregateKey?: string
  notificationId?: string
  /** When the timer fires. */
  dueAt: number
  /** Cancellation token — bump to invalidate before firing. */
  cancelToken: string
  state: "armed" | "fired" | "cancelled" | "expired"
  /** What cancelled it — evidence for the audit trail. */
  cancelReason?: string
  createdAt: number
  updatedAt: number
}

// ─── Aggregate members ───────────────────────────────────────────────────────

/** One fact folded into a digest bucket — durable crash-recovery evidence. */
export interface NotificationAggregateMember {
  id: string
  scopeKey: string
  /** The bucket — `{scope}:{kind}:{template-rendered}` or explicit key. */
  aggregateKey: string
  /** The fact folded in (NotificationRecord.id or projection factKey). */
  notificationId: string
  logicalKey?: string
  /** When the fact joined the bucket. */
  joinedAt: number
  /** The bucket's open/closed boundary at join time. */
  bucketOpenedAt: number
  /** Whether this member has been flushed in a digest send. */
  flushedAt?: number
  createdAt: number
}
