/**
 * Shared synchronous token-count facade for renderer prompt estimates.
 *
 * `lib/ai/embedding/compression.ts` imports `calculateTokenBreakdown` and
 * `countTokens` to estimate prompt sizes. The implementation delegates to the
 * shared lightweight `cl100k_base` encoder without requiring a React hook.
 */
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"

export function countTokens(text: string | undefined | null): number {
  return estimateFallbackTokens(text)
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
