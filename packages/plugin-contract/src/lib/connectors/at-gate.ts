/**
 * The plugin contract's share of `lib/connectors/at-gate.ts`, which re-exports these.
 */
import type { ConversationAdmissionReason } from "./conversation-admission"

export type AtGateReason =
  | "chat_blocklist"
  | "chat_allowlist"
  | "at_mention_required"
  | "at_direct_only"
  | ConversationAdmissionReason

export interface AtGateDecision {
  allowed: boolean
  reason?: AtGateReason
}
