/**
 * Built-in compaction / memory instructions.
 *
 * Two outputs, both composed from the SINGLE canonical summary prompt
 * (`CONVERSATION_SUMMARY_SYSTEM_PROMPT`, owned by `lib/ai/generation/summarizer.ts`)
 * — this module never forks the summarization wording:
 *
 *  • {@link buildCompactionSummaryPrompt} — the system prompt the sidecar uses
 *    when it summarizes older turns. Canonical prompt + the user's optional
 *    `focus` (Claude Code's `# Compact instructions` parity). Serialised onto
 *    `SendOptions.compaction.summaryPrompt` by `resolveSendOptions`.
 *
 *  • {@link COMPACT_HANDOFF_SNIPPET} / {@link resolveCompactInstructions} — a
 *    short fragment appended to the LIVE agent's system prompt so it keeps
 *    durable notes ahead of a compaction boundary (Codex `SUMMARY_PREFIX`
 *    handoff + Claude Code memory-tool "ASSUME INTERRUPTION" guidance — the one
 *    piece with no existing equivalent in the repo).
 */

import { CONVERSATION_SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/generation/summarizer"
import { AUTO_COMPACT_FRACTION } from "@/lib/claude/usage"
import type { ResolvedCompaction } from "@/lib/claude/types"
import type { CompressionSettings, SessionCompressionOverrides } from "@/types/system/compression"
import type { PluginCompactionStrategyDef } from "@/types/plugin/plugin-compaction-strategy"

/** Default number of most-recent turns kept verbatim (mirrors the sidecar). */
export const DEFAULT_KEEP_RECENT = 6

/**
 * Appended to the live agent's system prompt (gated on compaction enabled).
 * Tells the model its context may be summarized + truncated mid-task and to
 * surface the facts it depends on before they are compacted away.
 */
export const COMPACT_HANDOFF_SNIPPET =
  "Context-compaction awareness: this conversation may be summarized and " +
  "truncated at any point to stay within the model's context window. Assume " +
  "interruption — do not rely on earlier turns remaining verbatim. Before long " +
  "tool sequences, restate the durable facts you depend on (the user's goal, " +
  "key decisions, file paths, and open threads) so they survive a compaction " +
  "boundary. After a compaction, the summary you receive is authoritative for " +
  "everything before it; build on it rather than re-deriving prior work."

/**
 * Compose the summarization system prompt: the canonical conversation-summary
 * prompt plus the user's optional focus instruction. Returns the canonical
 * prompt unchanged when there is no focus.
 */
export function buildCompactionSummaryPrompt(focus?: string): string {
  const trimmed = focus?.trim()
  if (!trimmed) return CONVERSATION_SUMMARY_SYSTEM_PROMPT
  return `${CONVERSATION_SUMMARY_SYSTEM_PROMPT}\n\nFocus especially on: ${trimmed}`
}

/**
 * Compose the live-agent system-prompt fragment: the handoff snippet plus the
 * user's optional focus instruction.
 */
export function resolveCompactInstructions(focus?: string): string {
  const trimmed = focus?.trim()
  if (!trimmed) return COMPACT_HANDOFF_SNIPPET
  return `${COMPACT_HANDOFF_SNIPPET}\n\nWhen compacting, focus on: ${trimmed}`
}

/** Inputs to {@link resolveCompaction}; all optional / partial. */
export interface ResolveCompactionInput {
  /** App-wide compaction settings (partial — stored keys only). */
  appComp?: Partial<CompressionSettings>
  /** Per-character override. */
  charOv?: SessionCompressionOverrides
  /** Per-session override (highest precedence). */
  sessOv?: SessionCompressionOverrides
  /** The resolved active strategy def (built-in → undefined). */
  strategy?: PluginCompactionStrategyDef
}

/** Percentage (0-100) → fraction (0-1); undefined/≤0 → undefined. */
function pctToFraction(p: number | undefined): number | undefined {
  return typeof p === "number" && p > 0 ? p / 100 : undefined
}

/**
 * Pure resolver for the sidecar compaction config. Precedence per field is
 * session ← character ← appSettings ← strategy ← built-in default. The summary
 * prompt comes from the active strategy (or the canonical prompt) with the
 * user `focus` layered on top. Kept pure (no registry / I/O) so it is unit
 * tested directly — `resolveSendOptions` looks the strategy up and calls this.
 */
export function resolveCompaction(input: ResolveCompactionInput): ResolvedCompaction {
  const { appComp, charOv, sessOv, strategy } = input

  const enabled =
    sessOv?.compressionEnabled ?? charOv?.compressionEnabled ?? appComp?.enabled ?? true

  const focus = appComp?.focus?.trim() || undefined

  const fraction =
    pctToFraction(sessOv?.tokenThreshold) ??
    pctToFraction(charOv?.tokenThreshold) ??
    pctToFraction(appComp?.tokenThreshold) ??
    strategy?.fraction ??
    AUTO_COMPACT_FRACTION

  const keepRecent =
    sessOv?.preserveRecentMessages ??
    charOv?.preserveRecentMessages ??
    appComp?.preserveRecentMessages ??
    strategy?.keepRecent ??
    DEFAULT_KEEP_RECENT

  const summaryPrompt = strategy?.summaryPrompt
    ? focus
      ? `${strategy.summaryPrompt}\n\nFocus especially on: ${focus}`
      : strategy.summaryPrompt
    : buildCompactionSummaryPrompt(focus)

  return { enabled, fraction, keepRecent, focus, summaryPrompt }
}
