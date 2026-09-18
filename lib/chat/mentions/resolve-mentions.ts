/**
 * Send-time mention capture: map the inline `@…` tokens in an outgoing
 * message to structured `ContextRef`s.
 *
 * Runs on the final text (not on pick events) so typed and pasted mentions
 * are captured identically to popover picks. Token splitting reuses
 * `parseSegments`/`splitMentionSegments` — the same parser the composer
 * overlay uses — so what renders as a mention chip is exactly what persists.
 *
 * Resolution is best-effort against the data sources the caller has in
 * scope: a token matching a known agent/subagent handle resolves to that
 * kind; everything else falls back to `kind: "file"` (the dominant mention
 * type, and the CLI's native interpretation of `@path`).
 */

import { parseSegments, splitMentionSegments } from "@/lib/slash-commands/parse-segments"
import type { SendContent } from "@cognia/agent-config-types"
import { stripPromptPreamble } from "@/lib/chat/prompt-preamble"
import { mergeContextRefs } from "./merge-refs"
import type { ContextRef } from "./types"

export interface MentionResolvers {
  /** Resolve `name` (token without `@`) to an agent/subagent ref, or null. */
  resolveAgentHandle(name: string): ContextRef | null
}

export function resolveMentions(text: string, resolvers: MentionResolvers): ContextRef[] {
  if (!text.includes("@")) return []
  // Slash-command detection is irrelevant for mention capture; treat every
  // line-start `/word` as text so command args' mentions still resolve.
  const segments = splitMentionSegments(parseSegments(text, () => false))
  const refs: ContextRef[] = []
  const seen = new Set<string>()
  for (const seg of segments) {
    if (seg.kind !== "mention") continue
    const agentRef = resolvers.resolveAgentHandle(seg.name)
    const ref: ContextRef = agentRef ?? { kind: "file", id: seg.name, raw: seg.raw }
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(agentRef ? { ...agentRef, raw: agentRef.raw ?? seg.raw } : ref)
  }
  return refs
}

/**
 * The complete `metadata.mentions` one outgoing turn claims: the `@…` tokens
 * still present in the typed text PLUS the token-less citations the composer
 * attached (staged records, documents, context chips).
 *
 * This is the single contract every send path must share — a normal send, a
 * live or queued steer, a shared-session publish, a room turn. Each used to
 * re-implement (or skip) the merge, which is how a steered `@chat:` message
 * could reach the model while its persisted row recorded no citation at all.
 *
 * Parsing runs on the preamble-stripped text: an `@path` inside a referenced
 * snapshot or a fetched page is quoted material, not a mention this turn made.
 * `citations` is caller-supplied rather than read from the store so a first
 * turn staged under no conversation still resolves.
 */
export function resolveTurnContextRefs(
  content: SendContent,
  resolvers: MentionResolvers,
  citations: readonly ContextRef[] = []
): ContextRef[] {
  const sourceText =
    typeof content === "string"
      ? stripPromptPreamble(content)
      : content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b, index) => (index === 0 ? stripPromptPreamble(b.text) : b.text))
          .join("\n")
  const parsed = sourceText.includes("@") ? resolveMentions(sourceText, resolvers) : []
  return mergeContextRefs(parsed, citations)
}
