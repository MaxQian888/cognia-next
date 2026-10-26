/**
 * The plain text of a stored or streamed message, for the background utility
 * tasks that ask what was said (titles, timeline labels, memory extraction).
 *
 * Kept free of stores and the chat runtime so a Host's brain can read a
 * transcript with it without loading the chat view: these two used to live in
 * `hooks/chat/claude-chat-turn-tasks.ts`, which still re-exports them.
 */

import type { UIMessage } from "ai"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"

function textOfParts(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      const p = part as { type?: string; text?: string }
      return p.type === "text" && typeof p.text === "string" ? p.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

/**
 * Pull plain assistant text out of a UIMessage's parts. Used to feed the
 * artifact detector; only the rendered text content is meaningful — tool
 * calls and reasoning blocks are ignored.
 */
export function extractAssistantText(message: UIMessage | undefined): string {
  if (!message || message.role !== "assistant") return ""
  return textOfParts(message.parts)
}

/**
 * Pull plain text out of any UIMessage's `text` parts (role-agnostic).
 *
 * Without the composer's context envelope: every caller here — the generated
 * title, the timeline label, the memory extractor — is asking what the user
 * SAID. A title distilled from a referenced document, or a memory crediting the
 * user with a page of web results, is the failure that skipping it prevents.
 */
export function extractPlainText(message: UIMessage | undefined): string {
  if (!message) return ""
  return textOfParts(stripPromptPreambleFromParts(message.parts))
}
