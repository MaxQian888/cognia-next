/**
 * Auto-compaction decision (OpenCode parity).
 *
 * The CLI shipped only a manual `/compact`; a long session would creep up to the
 * window limit and then start dropping the oldest turns (or erroring) with no
 * warning. OpenCode compacts automatically as the context fills, summarising the
 * older turns before they overflow. This module is the pure decision behind that
 * — the App drives a between-turn effect off it, so the threshold math stays
 * unit-tested without a live session.
 */
import { computeContextWindowUsage } from "@/lib/claude/usage"
import type { UsageInfo } from "@/lib/claude/adapter"

/** Default fill fraction at which auto-compaction fires (matches the gauge's ┊). */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.85
const MIN_THRESHOLD = 0.5
const MAX_THRESHOLD = 0.98

/** Clamp a configured threshold into the sane [0.5, 0.98] band (NaN ⇒ default). */
export function resolveAutoCompactThreshold(raw: number | undefined): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return DEFAULT_AUTO_COMPACT_THRESHOLD
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, raw))
}

export interface AutoCompactInput {
  /** Latest reported usage; `null`/absent ⇒ never compact (nothing to measure). */
  usage: UsageInfo | null | undefined
  /** Active model, for the per-model window math. */
  model?: string
  /** Resolved per-model window (catalog), pinning the math to the footer gauge. */
  contextWindow?: number
  /** Master switch (config.autoCompact). When false the decision is always false. */
  enabled: boolean
  /** Fill fraction trigger; clamped via {@link resolveAutoCompactThreshold}. */
  threshold?: number
}

/**
 * Whether the live context should auto-compact now: enabled, usage known, and
 * the used fraction has reached the (clamped) threshold. The caller is expected
 * to guard against re-firing before the next turn's usage lands (re-arm once the
 * fraction drops back below the threshold after a compaction).
 */
export function shouldAutoCompact(input: AutoCompactInput): boolean {
  if (!input.enabled) return false
  if (!input.usage) return false
  const ctx = computeContextWindowUsage(
    input.usage,
    input.model,
    input.contextWindow && input.contextWindow > 0 ? input.contextWindow : undefined
  )
  if (ctx.max <= 0) return false
  return ctx.fraction >= resolveAutoCompactThreshold(input.threshold)
}
