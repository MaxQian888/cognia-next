// Rolling pet conversation history (the `talked` LLM side channel). One row per
// completed talk turn; proactive utterances are deliberately NEVER recorded
// (skip-memory — the pet must not cite its own idle chatter). Capped at 200
// rows in `lib/db/pet-conversation.ts`; the prompt window reads the newest ~12.

export interface PetConversationRow {
  /** Auto-increment primary key (absent before insert). */
  id?: number
  /** Epoch ms of the turn. */
  at: number
  /** What the user said to the pet. */
  userText: string
  /** The pet's (sanitized, tag-stripped) reply. */
  reply: string
}
