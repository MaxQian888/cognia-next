/**
 * `PlatformAdapter.messageRoute` answers shared by the adapters (ADR-0239):
 * where a delivery through a conversation reference lands when it replies to
 * or edits a message.
 */

import type { MessageRoute } from "@/types/connectors"

/**
 * For an adapter that sends every delivery to the reference's chat: it
 * ignores a reply's message id or keeps it inside that chat, and has no edit
 * (the outbound runner sends an edit as a new message there).
 */
export async function conversationBoundRoute(): Promise<MessageRoute> {
  return "within"
}

/**
 * For an adapter that replies inside the reference's chat, and edits the
 * chat a composite id names (`<chat><sep><message>`), else the reference's.
 * `idChat` is the chat the id names, `undefined` for a bare id; `refChat` the
 * reference's, empty when it names none.
 */
export function compositeEditRoute(
  use: "reply" | "edit",
  idChat: string | undefined,
  refChat: string
): MessageRoute {
  if (use === "reply") return "within"
  if (idChat === undefined) return refChat ? "within" : "unknown"
  if (!refChat) return "unknown"
  return idChat === refChat ? "within" : "elsewhere"
}
