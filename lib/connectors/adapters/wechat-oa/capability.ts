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
 *
 * `typing` — `POST /cgi-bin/message/custom/typing` (`Typing` /
 * `CancelTyping`), same 48h-window constraint as sends (45015 / 45047 are
 * swallowed as best-effort). Absent on purpose: `delete` / `edit` (客服
 * messages cannot be recalled or edited — UNVERIFIED reverse confirmation),
 * `history.fetch` (no message-timeline read for official accounts) and
 * `send.reaction` (no reaction API).
 */
export const WECHAT_OA_CAPS: readonly Capability[] = ["send.text", "typing"] as const

/** A2UI degrades to the plain-text mirror — WeChat OA text has no interactive surface. */
export const WECHAT_OA_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({})
