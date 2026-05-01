/**
 * Stub for `@/lib/ai/generation/summarizer`.
 *
 * `lib/ai/embedding/compression.ts` dynamically imports
 * `generateAICompressionSummary` to summarize chat history when the context
 * window is exhausted. The full Cognia implementation routes through their
 * AI generation pipeline (with provider switching, caching, fallbacks).
 * cognia-next does not yet host that pipeline — for v1 we ship a structural
 * fallback so the compression flow still produces usable output without
 * requiring a separate LLM call.
 *
 * If a future PR wires a real summarizer, replace this with a thin wrapper
 * around `ai`'s `generateText` against the user's configured Anthropic key.
 */

import type { UIMessage } from "ai"

export async function generateAICompressionSummary(
  messages: UIMessage[],
  _config: { provider: string; model: string; apiKey: string; baseURL?: string },
  _targetTokens?: number
): Promise<string> {
  if (messages.length === 0) return ""
  const head = messages.slice(0, 3)
  const tail = messages.slice(-3)
  const summarizePart = (m: UIMessage) => {
    const text =
      typeof (m as unknown as { content?: unknown }).content === "string"
        ? ((m as unknown as { content: string }).content as string).slice(0, 80)
        : `[${m.role}]`
    return `${m.role}: ${text}`
  }
  return [
    `[Compressed conversation: ${messages.length} messages]`,
    "Beginning:",
    ...head.map(summarizePart),
    `…(${Math.max(0, messages.length - 6)} messages elided)…`,
    "Recent:",
    ...tail.map(summarizePart),
  ].join("\n")
}
