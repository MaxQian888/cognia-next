// Pure conversation-history glue for the pet LLM channel. Storage is injected
// (`lib/db/pet-conversation.ts` in production) so the module unit-tests without
// IndexedDB and the speak path can never be broken by a storage failure — every
// operation degrades to "no history".

import { hasNoLeakingPii } from "@cognia/redact"
import type { PetConversationRow } from "@/types/pet"

export interface PetHistoryDeps {
  append: (row: Omit<PetConversationRow, "id">) => Promise<unknown>
  listRecent: (limit: number) => Promise<PetConversationRow[]>
}

/** Turns included in the prompt's history layer. */
export const HISTORY_PROMPT_LIMIT = 12

export interface RecordTurnInput {
  userText: string
  reply: string
  at: number
}

/** Persist one completed talk turn. Failures are swallowed — speak never breaks. */
export async function recordTurn(deps: PetHistoryDeps, input: RecordTurnInput): Promise<void> {
  try {
    await deps.append({ at: input.at, userText: input.userText, reply: input.reply })
  } catch {
    // History is best-effort; the bubble already rendered.
  }
}

/** Newest turns in chronological order (newest last); [] on any failure. */
export async function loadHistoryForPrompt(
  deps: PetHistoryDeps,
  opts: { limit?: number } = {}
): Promise<PetConversationRow[]> {
  try {
    return await deps.listRecent(opts.limit ?? HISTORY_PROMPT_LIMIT)
  } catch {
    return []
  }
}

/**
 * Render history as prompt lines ("User: …\nYou: …"), or "" when empty.
 *
 * Every turn passes the PII gate before it can be replayed. The user's half was
 * already gated when it was first sent, but the pet's REPLY never was, and the
 * TTS path gates that same reply on the stated premise that a model can echo
 * back a fact recalled from long-term memory. Storing an ungated reply and
 * replaying it into the next prompt let exactly that fact back out, to whatever
 * provider is configured by then, which may not be the one that produced it.
 *
 * Filtering happens on READ so rows written before the gate existed are covered
 * too. A turn that trips it is dropped on its own rather than degrading the
 * whole history layer.
 */
export function formatHistoryLines(turns: PetConversationRow[]): string {
  return turns
    .filter((t) => hasNoLeakingPii(t.userText) && hasNoLeakingPii(t.reply))
    .map((t) => `User: ${t.userText}\nYou: ${t.reply}`)
    .join("\n")
}
