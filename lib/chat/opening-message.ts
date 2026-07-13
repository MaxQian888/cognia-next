import type { UIMessage } from "ai"

import type { Character } from "@cognia/agent-config-types"

/**
 * Build the seed assistant greeting for a character (ADR-0030
 * `persona.openingMessage`). Returns `null` when the character has no
 * persona opening message, so callers can fall through to an empty session.
 *
 * The returned message is a plain assistant turn with a single text part —
 * the same shape `use-claude-chat` produces for streamed replies. It is a
 * display-only greeting: it is persisted for continuity but is not replayed
 * to the model as a prior turn (a fresh session starts from the user's first
 * prompt).
 */
export function buildOpeningMessage(character: Character | null | undefined): UIMessage | null {
  const text = character?.persona?.openingMessage?.trim()
  if (!text) return null
  return {
    id: `opening-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    parts: [{ type: "text", text, state: "done" }],
  } as UIMessage
}
