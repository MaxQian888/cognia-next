import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags for the WeChat Official Account adapter.
 *
 * Replies go through the 客服 message API, which supports text (and image /
 * news, deferred to a later pass). The 48-hour customer-service window
 * constrains proactive sends — outside it, only template messages (separate
 * approval) are allowed, so the adapter is reply-oriented. v1 declares text
 * only; richer message types degrade to text.
 */
export const WECHAT_OA_CAPS: readonly Capability[] = ["send.text"] as const

/** A2UI degrades to the plain-text mirror — WeChat OA text has no interactive surface. */
export const WECHAT_OA_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({})
