/**
 * Helpers for surfacing token / context-window usage in the UI.
 *
 * The Claude Agent SDK delivers usage numbers on a result message; the
 * adapter at `lib/claude/adapter.ts` already attaches them as
 * `metadata.usage` (shape = `UsageInfo`) on the most recent assistant
 * message. The composer's bottom toolbar reads from there.
 */

import type { UIMessage } from "ai"
import type { UsageInfo } from "@/lib/claude/adapter"

/**
 * Default context-window sizes for known Claude model ids.
 *
 * The lookup tolerates partial / aliased ids (e.g. `claude-sonnet-4-5` matches
 * any string that contains it). Unknown models fall back to the safe default
 * of 200k, which is correct for current Sonnet / Opus / Haiku.
 */
const MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; window: number }> = [
  // Sonnet 4.5 / 4.6 / 4.7 — 1M context tier
  { pattern: /sonnet-4-(5|6|7).*1m/i, window: 1_000_000 },
  { pattern: /\[1m\]$/i, window: 1_000_000 },
  // Default 200k for current Anthropic frontier models
  { pattern: /opus|sonnet|haiku/i, window: 200_000 },
]

export const DEFAULT_CONTEXT_WINDOW = 200_000

export function getModelContextWindow(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW
  for (const { pattern, window } of MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(modelId)) return window
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Pull the latest `UsageInfo` from the message log. Walks from the tail
 * forward so streaming-in-progress doesn't reset the indicator to zero.
 */
export function getLatestUsage(messages: UIMessage[]): UsageInfo | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const meta = (msg as { metadata?: Record<string, unknown> }).metadata
    if (!meta) continue
    const usage = meta.usage as UsageInfo | undefined
    if (!usage) continue
    if (
      usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.cacheReadInputTokens !== undefined
    ) {
      return usage
    }
  }
  return null
}

/**
 * Tokens that count toward the *active* context window.
 *
 * `cacheCreationInputTokens` is billed but represents tokens being written
 * into the prompt cache for *future* turns — they don't add to today's
 * window. `cacheReadInputTokens` are real prompt tokens being read back, so
 * they do count.
 */
export function tokensInWindow(usage: UsageInfo): number {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cacheRead = usage.cacheReadInputTokens ?? 0
  return input + output + cacheRead
}
