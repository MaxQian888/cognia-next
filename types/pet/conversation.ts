// Rolling pet conversation history (the `talked` LLM side channel). One row per
// completed talk turn; proactive utterances are deliberately NEVER recorded
// (skip-memory — the pet must not cite its own idle chatter). Capped at 200
// rows in `lib/db/pet-conversation.ts`; the prompt window reads the newest ~12.

export interface PetConversationRow {
  /**
   * Minted primary key.
   *
   * This was an auto-increment number until the table moved to
   * encrypted-content. The encryption middleware requires a primary key to
   * exist BEFORE the row is written, and an auto-increment key does not exist
   * until Dexie has written it, so every append would have thrown.
   */
  id: string
  /** Epoch ms of the turn. */
  at: number
  /** What the user said to the pet. */
  userText: string
  /** The pet's (sanitized, tag-stripped) reply. */
  reply: string
}
