/**
 * Typed reader for persisted message mentions.
 *
 * New messages carry `metadata.mentions: ContextRef[]` (written at send time
 * by the chat hook: `resolve-mentions.ts` for the tokens still in the text,
 * plus the composer's recorded chip-style picks); legacy messages fall back to
 * re-parsing the stored text with the same splitter, every token resolving
 * as `kind: "file"` (identity data for other kinds is gone by read time).
 *
 * Read by `lib/db/chat-search-text.ts`, which folds the mention labels into the
 * message's search projection — that is what makes a chip-style citation
 * findable at all, since it left no text behind to match.
 */

import { resolveMentions } from "./resolve-mentions"
import type { ContextRef, ContextRefKind } from "./types"

const KINDS: ReadonlySet<string> = new Set([
  "file",
  "agent",
  "subagent",
  "skill",
  "preset",
  "wfNode",
  "wfEdge",
  "doc",
  "entity",
] satisfies ContextRefKind[])

function isContextRef(value: unknown): value is ContextRef {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === "string" && typeof v.kind === "string" && KINDS.has(v.kind)
}

export interface MentionReadableMessage {
  metadata?: Record<string, unknown>
  /** Plain-text content for the legacy fallback path. */
  text?: string
}

export function getMessageMentions(message: MentionReadableMessage): ContextRef[] {
  const stored = message.metadata?.mentions
  if (Array.isArray(stored)) {
    return stored.filter(isContextRef)
  }
  if (typeof message.text === "string" && message.text.length > 0) {
    return resolveMentions(message.text, { resolveAgentHandle: () => null })
  }
  return []
}
