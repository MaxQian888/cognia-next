/**
 * The plugin contract's share of `lib/usage/session-analytics.ts`, which re-exports these.
 */
import type { UsageSurface } from "../db/session-usage"

export interface ModelUsageRow {
  model: string
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Cache-write (creation) tokens — surfaced as a detailed-mode column. */
  cacheCreationTokens: number
  costUsd: number
  /**
   * Sum of SDK-reported active generation time (ms) across this model's turns.
   * 0 when no turn reported a duration (non-SDK paths). Pairs with
   * `outputTokens` to derive throughput via {@link tokensPerSecond}.
   */
  durationMs: number
  /**
   * Sum of reasoning / "thinking" tokens (a subset of `outputTokens`) across
   * this model's turns. 0 when the model / provider never broke them out.
   */
  reasoningTokens: number
  /**
   * Turns whose cost could not be priced by any layer. `costUsd` for those
   * turns contributed 0, so a bucket with `unpricedTurns > 0` is a LOWER BOUND
   * on real spend and must be rendered as such (a "≥" marker or a footnote) —
   * never as a settled figure. 0 means every turn in the bucket was priced.
   */
  unpricedTurns: number
}

/** One usage bucket keyed by producing surface (chat / workflow / agent-team / …). */
export interface SurfaceUsageRow extends Omit<ModelUsageRow, "model"> {
  /** Producing surface; legacy rows with no `surface` are counted as `chat`. */
  surface: UsageSurface
}

/**
 * One "what's contributing to your usage" characteristic. These are *independent*
 * characteristics of the usage in range (not a breakdown that sums to 100%), so
 * each carries its own percentage and is shown only when it actually applies.
 */
export interface UsageContributor {
  id: "high-context" | "automated-surface"
  /** This characteristic's share, 0–100 rounded (% of turns or % of cost). */
  pct: number
}
