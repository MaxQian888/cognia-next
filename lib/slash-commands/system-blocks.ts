// Structured payloads for slash-command system messages. Diagnostics commands
// (/context, /usage, /cost) emit one of these instead of a markdown string so
// the chat transcript can render a proper card (progress bars, badges) rather
// than a flat bullet list. `pushSystemMessage` accepts `string | SystemMessageBlock`
// and the message renderer dispatches blocks to `<DiagnosticsCard>` via a
// `data-diagnostics` UI message part.

import type { ContextLevel } from "@/lib/claude/usage"
import type { UsageLevel } from "@/lib/subscription/anthropic/usage-analytics"
import type { UsageWindowsSource } from "@/lib/subscription/anthropic/overview-windows"
import type { UsageNote, UsageScopeReport } from "@/lib/usage/usage-report"
import type { LimitsMeter, RepresentativeClaim, UsageStatus } from "@/types/subscription"

/** UI message part type carrying a {@link SystemMessageBlock}. */
export const DIAGNOSTICS_PART_TYPE = "data-diagnostics" as const

/** Context-window occupancy shared by /context and /cost. */
export interface DiagnosticsWindow {
  used: number
  max: number
  /** 0..1 fill. */
  fraction: number
  remaining: number
  level: ContextLevel
  compactThresholdTokens: number
  /** 0..1 auto-compact threshold (matches the composer indicator marker). */
  autoCompactFraction: number
}

/** `/context` — local conversation buffer + window occupancy. */
export interface ContextDiagnosticsBlock {
  kind: "context"
  userTurns: number
  assistantTurns: number
  /** Cumulative token tallies; absent before any metrics arrive. */
  tokens?: {
    input: number
    output: number
    cacheRead: number
    cacheCreate: number
  }
  window?: DiagnosticsWindow
}

/** `/cost` — cumulative billed usage for the session. */
export interface CostDiagnosticsBlock {
  kind: "cost"
  assistantTurns: number
  metricTurns: number
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  /** USD; null when neither the SDK nor the pricing tables could price it. */
  costUsd: number | null
  /** True when `costUsd` came from the local pricing estimate (no SDK figure). */
  costEstimated: boolean
  durationMs: number
  window?: DiagnosticsWindow
}

/**
 * One Anthropic subscription quota window, as the FIRST version of the `/usage`
 * block recorded it. Only the two header-derived windows existed then.
 *
 * Still read, never written: transcripts persist their message parts, so a card
 * rendered from a chat that ran before the block gained `meters` must keep
 * working. New blocks carry {@link UsageDiagnosticsBlock.meters} instead, which
 * also covers the per-model weekly tiers the header path cannot see.
 */
export interface UsageWindowStat {
  key: "fiveHour" | "sevenDay"
  /** Whole-percent utilization, or null when the window wasn't reported. */
  utilization: number | null
  level: UsageLevel | null
  msUntilReset: number | null
}

/**
 * `/usage` — plan quota plus the local spend that explains it.
 *
 * The two planes are deliberately separate fields (see `lib/usage/usage-report.ts`):
 * `meters`/`extras` are the provider's accounting of the plan, `scopes` is what
 * this install recorded. Neither is derivable from the other.
 *
 * Every field below `overageDisabledReason` is optional because a persisted v1
 * block has none of them; the renderer treats absent as "this block predates
 * the field", not as "measured zero".
 */
export interface UsageDiagnosticsBlock {
  kind: "usage"
  /** @deprecated v1 shape. Present only on blocks recorded before `meters`. */
  windows?: UsageWindowStat[]
  /**
   * Fused quota windows — session / weekly / weekly_opus / weekly_sonnet, plus
   * any tier the provider added that we don't model yet (those carry a raw
   * `label` and no `labelKey`). Empty when no quota reading was available.
   */
  meters?: LimitsMeter[]
  /** Non-window meters from the same snapshot (pay-as-you-go overage). */
  extras?: LimitsMeter[]
  /** Which snapshot won the fuse, or null when neither was available. */
  source?: UsageWindowsSource | null
  /** When the winning snapshot was taken (epoch ms). */
  fetchedAt?: number | null
  /** Unified rate-limit status; only set when the header sample is the source. */
  status?: UsageStatus | null
  representativeClaim?: RepresentativeClaim | null
  fallbackPercentage: number | null
  overageDisabledReason: string | null
  /** Precomputed local-spend attribution, narrowest scope first. */
  scopes?: UsageScopeReport[]
  /** Whether an active chat session scoped the first entry of `scopes`. */
  hasSession?: boolean
  /** Non-fatal explanations for anything missing or degraded. */
  notes?: UsageNote[]
  /** Command-time clock, so reset countdowns render against a fixed origin. */
  generatedAt?: number
}

export type SystemMessageBlock =
  ContextDiagnosticsBlock | CostDiagnosticsBlock | UsageDiagnosticsBlock

/** Narrowing guard for the renderer's `data-diagnostics` part. */
export function isSystemMessageBlock(value: unknown): value is SystemMessageBlock {
  if (!value || typeof value !== "object") return false
  const kind = (value as { kind?: unknown }).kind
  return kind === "context" || kind === "cost" || kind === "usage"
}

/**
 * Inline marker shown alongside a system message produced by a `/<command>`
 * Action handler — a compact "this came from /resume, not the model" chip with
 * the triggering command + an optional one-line summary. Carried through the
 * same `data-diagnostics` part as the diagnostics blocks; the renderer
 * dispatches on `kind` (see `isSlashCommandResultBlock`). Rendered by
 * `SlashCommandResultChip`.
 */
export interface SlashCommandResultBlock {
  kind: "slash-result"
  /** Name of the command that fired (without the leading `/`). */
  commandId: string
  /** Optional argument string the user typed after the command name. */
  args?: string
  /** Inline summary; falls through to a default i18n message if omitted. */
  summary?: string
}

/** Narrowing guard for the slash-command result chip block. */
export function isSlashCommandResultBlock(value: unknown): value is SlashCommandResultBlock {
  if (!value || typeof value !== "object") return false
  return (value as { kind?: unknown }).kind === "slash-result"
}
