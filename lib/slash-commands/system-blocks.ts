// Structured payloads for slash-command system messages. Diagnostics commands
// (/context, /usage, /cost) emit one of these instead of a markdown string so
// the chat transcript can render a proper card (progress bars, badges) rather
// than a flat bullet list. `pushSystemMessage` accepts `string | SystemMessageBlock`
// and the message renderer dispatches blocks to `<DiagnosticsCard>` via a
// `data-diagnostics` UI message part.

import type { ContextLevel } from "@/lib/claude/usage"
import type { UsageLevel } from "@/lib/subscription/anthropic/usage-analytics"

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

/** One Anthropic subscription quota window (5h / 7d). */
export interface UsageWindowStat {
  key: "fiveHour" | "sevenDay"
  /** Whole-percent utilization, or null when the window wasn't reported. */
  utilization: number | null
  level: UsageLevel | null
  msUntilReset: number | null
}

/** `/usage` — Anthropic subscription quota windows. */
export interface UsageDiagnosticsBlock {
  kind: "usage"
  windows: UsageWindowStat[]
  fallbackPercentage: number | null
  overageDisabledReason: string | null
}

export type SystemMessageBlock =
  | ContextDiagnosticsBlock
  | CostDiagnosticsBlock
  | UsageDiagnosticsBlock

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
