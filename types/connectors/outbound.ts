import type { ConversationReference } from "./event"
import type { MessageSegment, SegmentType } from "./segment"

export interface OutboundRequest {
  conversationRef: ConversationReference
  segments: MessageSegment[]
  replyTo?: { messageId: string }
  threadId?: string
  metadata: {
    /** Stable across retries; required. */
    idempotencyKey: string
    /** When this is a reply, the inbound StoredMessage.id that triggered it. */
    sourceMessageId?: string
    /** When this comes from a scheduled task, the task id. */
    scheduledTaskId?: string
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
