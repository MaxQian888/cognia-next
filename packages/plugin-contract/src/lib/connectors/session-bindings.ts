/**
 * The plugin contract's share of `lib/connectors/session-bindings.ts`, which re-exports these.
 */
/** A conversation bound to the same remote chat through ANOTHER adapter. */
export interface SiblingConversation {
  adapterId: string
  conversationKey: string
  sessionId: string
}
