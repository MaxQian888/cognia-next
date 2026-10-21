/**
 * The plugin contract's share of `lib/connectors/conversation-admission.ts`, which re-exports these.
 */
export type ConversationAdmissionReason =
  | "at_mention_required"
  | "at_direct_only"
  | "delivery_unverified"
  | "topic_activation_required"
  | "topic_activation_expired"
  /** The bound room's `replyMode` is `asleep` (ADR-0177 batch 3). */
  | "room_asleep"
