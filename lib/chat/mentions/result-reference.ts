/**
 * `@result:` / `^` — the body behind one indexed result.
 *
 * The index row (`lib/db/chat-result-index.ts`) carries a clamped preview so
 * the picker can list and match without loading anything. This is the other
 * half: at pick time the body is read back **from the owning message**, never
 * from the row.
 *
 * That split is the point. A preview is a few hundred characters chosen to be
 * recognisable; a reference has to be the whole result. And re-reading is what
 * makes the row safe to keep small and safe to be slightly stale — if the
 * message was edited between listing and picking, the user gets what the
 * message says now rather than what the index remembered.
 */

import { normalizeToolName } from "@/lib/chat/tool-summary"
import { isToolPart, projectToolOutputText } from "./tool-output-text"

/** Separator between the message and the part index in a result id. */
export const RESULT_ID_SEPARATOR = ":"

/**
 * Split a result id into its two halves, or null when it is not one.
 *
 * Split on the LAST separator: the index is always a number at the end, while
 * a message id from an imported transcript may itself contain a colon.
 */
export function parseResultId(id: string): { messageId: string; partIndex: number } | null {
  const at = id.lastIndexOf(RESULT_ID_SEPARATOR)
  if (at <= 0 || at === id.length - 1) return null
  const partIndex = Number(id.slice(at + 1))
  if (!Number.isInteger(partIndex) || partIndex < 0) return null
  return { messageId: id.slice(0, at), partIndex }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Render one already-loaded part as the referenced result.
 *
 * Headed by what produced it, because a bare wall of stdout tells the model
 * nothing about whether it is reading a file, a search or a failed command —
 * and the difference decides how much it should trust the content.
 *
 * Tool parts only, matching what the index holds. An artifact or canvas part is
 * a POINTER whose body lives in its own store, and `@artifact:` already reads
 * that live — see `ChatResultKind`.
 */
export function formatResultPart(part: unknown): string | null {
  if (!isObject(part) || !isToolPart(part)) return null
  const body = projectToolOutputText(part)
  if (!body) return null
  return `Result of ${normalizeToolName(part as never)}:\n${body}`
}

/**
 * The referenced result's body, or null when it is gone.
 *
 * `null` covers three real cases with one answer, which is the honest one: the
 * message was deleted, it was edited so the part is no longer at that index, or
 * the part is there but no longer produces readable output. In every one of
 * them the caller must say the record is unavailable rather than stage a chip
 * claiming to carry a result.
 */
export async function resultBodyText(resultId: string): Promise<string | null> {
  const parsed = parseResultId(resultId)
  if (!parsed) return null
  const { getDb } = await import("@/lib/db/schema")
  const message = await getDb().messages.get(parsed.messageId)
  if (!message || !Array.isArray(message.parts)) return null
  return formatResultPart(message.parts[parsed.partIndex])
}
