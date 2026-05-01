/**
 * Stub for `@/hooks/chat/use-token-count`.
 *
 * `lib/ai/embedding/compression.ts` imports `calculateTokenBreakdown` and
 * `countTokens` to estimate prompt sizes. cognia-next ships `js-tiktoken`
 * (used elsewhere); these wrappers compute approximate token counts
 * synchronously without requiring the React-hook surface that Cognia uses.
 *
 * If a future PR wants exact tiktoken counts, replace these with a
 * `js-tiktoken/lite` GPT-style encoder lookup.
 */

const APPROX_CHARS_PER_TOKEN = 4

export function countTokens(text: string | undefined | null): number {
  if (!text) return 0
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

export interface TokenBreakdown {
  total: number
  byMessage: number[]
}

export function calculateTokenBreakdown(parts: Array<string | undefined | null>): TokenBreakdown {
  const byMessage = parts.map((p) => countTokens(p))
  return {
    total: byMessage.reduce((acc, n) => acc + n, 0),
    byMessage,
  }
}
