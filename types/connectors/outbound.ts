import type { ConversationDeliveryTarget, ConversationReference } from "./event"
import type { MessageSegment, SegmentType } from "./segment"

export interface OutboundRequest {
  conversationRef: ConversationReference
  /** Complete persisted destination; preferred over the legacy loose reference. */
  deliveryTarget?: ConversationDeliveryTarget
  segments: MessageSegment[]
  replyTo?: { messageId: string }
  threadId?: string
  /**
   * When set, the outbound runner edits this existing platform message id
   * instead of sending a new one — the dispatch goes to `adapter.edit()`
   * rather than `adapter.send()`. Adapters that do not implement
   * `edit()` fall through to a new send (the runner detects via the
   * adapter capability check and audits the fallback). Used by the
   * workflow-progress-runner for in-place status card refresh.
   */
  editTargetMessageId?: string
  metadata: {
    /** Stable across retries; required. */
    idempotencyKey: string
    /** When this is a reply, the inbound StoredMessage.id that triggered it. */
    sourceMessageId?: string
    /** When this comes from a scheduled task, the task id. */
    scheduledTaskId?: string
    /**
     * Set when the outbound runner re-enqueued this job through a failover
     * sibling because the original adapter's circuit was open. Carries the
     * ORIGINAL adapter id, both as an audit trail and as the single-hop
     * guard: a job that already failed over once is dead-lettered (never
     * re-failed-over) if the sibling's circuit is open too.
     */
    failoverFromAdapterId?: string
    /**
     * Set when the outbound runner re-enqueued this job through a
     * load-balancing sibling because the original adapter's token bucket
     * was exhausted. Carries the ORIGINAL adapter id; together with
     * `failoverFromAdapterId` it forms the single-hop guard — a job that
     * was rerouted once (either mechanism) is never rerouted again.
     */
    balancedFromAdapterId?: string
  }
}

export interface OutboundError {
  /** Stable code: "rate_limited" | "auth_failed" | "platform_4xx" | "platform_5xx" | "network" | "validation" | "unsupported_segment" | "circuit_open" */
  code: string
  message: string
  retryable: boolean
  /** Optional platform-side hint ("retry-after seconds"). */
  retryAfterMs?: number
}

export interface SegmentDowngrade {
  from: SegmentType
  to: SegmentType
  reason: string
}

export interface OutboundResult {
  ok: boolean
  platformMessageId?: string
  error?: OutboundError
  downgrades?: SegmentDowngrade[]
}

/**
 * UUIDv4 generator using crypto.randomUUID() (available in jsdom 22+ and
 * all Tauri webview targets).
 */
export function newIdempotencyKey(): string {
  // crypto.randomUUID always returns lowercase canonical UUIDv4.
  return crypto.randomUUID()
}
