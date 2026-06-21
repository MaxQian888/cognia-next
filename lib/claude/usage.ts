/**
 * Helpers for surfacing token / context-window usage in the UI.
 *
 * The Claude Agent SDK delivers usage numbers on a result message; the
 * adapter at `lib/claude/adapter.ts` already attaches them as
 * `metadata.usage` (shape = `UsageInfo`) on the most recent assistant
 * message. The composer's bottom toolbar reads from there.
 *
 * This module is the SINGLE source of truth for context-window sizing and
 * occupancy. It deliberately keeps its own model→window table rather than
 * importing `types/provider/built-in-provider-catalog` so the provider data
 * set isn't pulled into the chat composer bundle; the table below is correct
 * for every model the Claude Agent SDK actually drives and falls back to a
 * safe 200k for anything unknown.
 */

import type { UIMessage } from "ai"
import type { UsageInfo } from "@/lib/claude/adapter"

/**
 * Default context-window size for an unknown / unrecognised model id. 200k is
 * the standard window for current Anthropic frontier tiers (Sonnet 4.5, Haiku
 * 4.5, Opus 4 / 4.1, all Claude 3.x), so it is the safe floor.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Fraction of the window at which Claude Code auto-compacts the conversation
 * (~83.5%). Drawn as the threshold marker on the indicator and reported by the
 * `/context` slash command. Exported so callers and tests share one constant.
 */
export const AUTO_COMPACT_FRACTION = 0.835

/**
 * Context-window sizes keyed by model id. Order matters — the first match
 * wins, so the explicit `[1m]` / `-1m` build suffix is checked before the
 * family defaults, and the 1M-tier Claude 4.6+ families before the generic
 * Claude fallback.
 *
 * Sources: Anthropic model docs (Opus/Sonnet 4.6+ = 1M; Sonnet 4.5 / Haiku 4.5
 * / Opus 4 / 4.1 / Claude 3.x = 200k); OpenAI (GPT-4o = 128k, GPT-4.1 = 1M,
 * o-series = 200k); Google (Gemini 1.5 / 2.5 / 3 = 1M).
 */
const MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; window: number }> = [
  // Explicit 1M build markers win regardless of family — `claude-opus-4-7[1m]`,
  // `claude-sonnet-4-6.1m`, `claude-sonnet-4-5-1m`.
  { pattern: /\[1m\]/i, window: 1_000_000 },
  { pattern: /[-._]1m(\b|$)/i, window: 1_000_000 },
  // Claude 4.6+ Opus / Sonnet — 1M context tier.
  { pattern: /claude-opus-4-(6|7|8)/i, window: 1_000_000 },
  { pattern: /claude-sonnet-4-(6|7|8)/i, window: 1_000_000 },
  // Every other Claude (Opus 4 / 4.1, Sonnet 4.5, Haiku 4.x, and all Claude
  // 3.x — `claude-3-5-sonnet` etc. still contain opus/sonnet/haiku) — 200k.
  { pattern: /claude-(opus|sonnet|haiku)/i, window: 200_000 },
  // OpenAI.
  { pattern: /gpt-4o/i, window: 128_000 },
  { pattern: /gpt-4\.1/i, window: 1_000_000 },
  { pattern: /(^|[^a-z])o[134]([^a-z]|$)/i, window: 200_000 },
  // Google Gemini long-context tiers.
  { pattern: /gemini-(1\.5|2\.5|3)/i, window: 1_000_000 },
]

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
 * Tokens occupying the *active* context window after a turn.
 *
 * Everything the model saw on the latest turn counts: the fresh input, the
 * tokens read back from the prompt cache, AND the tokens written into the
 * cache (they were part of this turn's prompt), plus the assistant output
 * (which becomes part of the next turn's prompt). This matches how Claude
 * Code and Codex report current context occupancy.
 */
export function tokensInWindow(usage: UsageInfo): number {
  // Prefer the explicit window-prompt size when the channel reports one (the
  // ai-sdk agent loop sums every leg's prompt into `inputTokens` for billing,
  // but only the last leg's prompt actually occupies the window).
  const input = usage.contextInputTokens ?? usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheCreation = usage.cacheCreationInputTokens ?? 0
  return input + output + cacheRead + cacheCreation
}

/**
 * Cumulative billed usage across an entire session.
 *
 * Distinct from {@link tokensInWindow} (which reports the *current* window
 * occupancy = latest turn only). Here every assistant turn is summed, because
 * an API bill re-charges the full prompt on every turn — so the session total
 * is what the user actually pays. `turns` is the number of assistant turns
 * that carried usage metadata.
 */
export interface SessionUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalCostUsd: number
  turns: number
}

/**
 * Sum usage across every assistant turn in the message log. A turn counts when
 * its assistant message carries a `usage` metadata object — even one with only
 * a cost and no token counts (the SDK result can be cost-only).
 */
export function sumSessionUsage(messages: UIMessage[]): SessionUsageTotals {
  const total: SessionUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
    turns: 0,
  }
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const meta = (msg as { metadata?: Record<string, unknown> }).metadata
    const usage = meta?.usage as UsageInfo | undefined
    if (!usage) continue
    total.inputTokens += usage.inputTokens ?? 0
    total.outputTokens += usage.outputTokens ?? 0
    total.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
    total.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
    total.totalCostUsd += usage.totalCostUsd ?? 0
    total.turns += 1
  }
  return total
}

/** Severity of context-window fill, mirroring the observability threshold dots. */
export type ContextLevel = "ok" | "warn" | "crit"

/**
 * Map a fill fraction to a severity level. `crit` is reached at the
 * auto-compact threshold; `warn` covers the run-up to it.
 */
export function contextLevel(fraction: number): ContextLevel {
  if (fraction >= AUTO_COMPACT_FRACTION) return "crit"
  if (fraction >= 0.6) return "warn"
  return "ok"
}

/** Fully-resolved context-window occupancy for the indicator + slash commands. */
export interface ContextWindowUsage {
  /** Tokens currently in the window (latest turn). */
  used: number
  /** Window size for the model. */
  max: number
  /** `used / max`, clamped to [0, 1]. */
  fraction: number
  /** Tokens of headroom before the window is full. */
  remaining: number
  /** Severity bucket for coloring. */
  level: ContextLevel
  /** Absolute token count at which auto-compaction triggers. */
  compactThresholdTokens: number
}

/**
 * Compute window occupancy from a single turn's usage. `usage` is the latest
 * turn (or null for a fresh session → 0 used). `maxOverride` lets callers pin
 * a window size (e.g. tests, or a non-default deployment).
 */
export function computeContextWindowUsage(
  usage: UsageInfo | null,
  modelId: string | undefined,
  maxOverride?: number
): ContextWindowUsage {
  const max = maxOverride ?? getModelContextWindow(modelId)
  const used = usage ? tokensInWindow(usage) : 0
  const fraction = max > 0 ? Math.min(1, used / max) : 0
  return {
    used,
    max,
    fraction,
    remaining: Math.max(0, max - used),
    level: contextLevel(fraction),
    compactThresholdTokens: Math.round(max * AUTO_COMPACT_FRACTION),
  }
}
