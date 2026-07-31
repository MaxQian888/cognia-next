/**
 * Built-in offline completion provider: prefix-matches the session's
 * recent command history. Always available (no model, no network), so the
 * autocomplete feature degrades to fish/zsh-style history suggestion when
 * no LLM is configured or the AI provider is disabled.
 *
 * Two tiers (ADR-0039 phase 2):
 *   1. The in-memory ring (`context.recentCommands`, this session only) —
 *      synchronous, instant, survives nothing.
 *   2. The durable `terminalHistory` Dexie table — cross-session and
 *      cross-tab, frequency + recency ranked with project/cwd boosts.
 *      Loaded lazily; any failure (no IndexedDB, schema mid-upgrade)
 *      degrades silently to tier 1.
 */

import type { TerminalCompletionProvider, TerminalCompletionSuggestion } from "./types"

const MAX_HISTORY_SUGGESTIONS = 3
/** How many durable rows to merge behind the ring matches. */
const MAX_DURABLE_SUGGESTIONS = 4

/** Tier 1 — synchronous prefix match over the session's ring. */
function ringMatches(input: string, recentCommands: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // Walk newest → oldest so the most recent match wins.
  for (let i = recentCommands.length - 1; i >= 0; i--) {
    const cmd = recentCommands[i]
    if (!cmd.startsWith(input) || cmd.length <= input.length) continue
    if (seen.has(cmd)) continue
    seen.add(cmd)
    out.push(cmd)
    if (out.length >= MAX_HISTORY_SUGGESTIONS) break
  }
  return out
}

export const historyProvider: TerminalCompletionProvider = {
  id: "builtin:history",
  label: "Command history",
  // Runs before the AI provider so an instant history hit can show while
  // the model call is still in flight; ranking still prefers AI on ties.
  priority: 10,
  getCompletions: async (context, signal) => {
    const input = context.input
    if (input.trim().length === 0) return []

    const ring = ringMatches(input, context.recentCommands)

    // Tier 2 — durable cross-session history. Failure → ring only.
    let durable: string[] = []
    try {
      const { queryTerminalHistory } = await import("@/lib/db/terminal-history")
      const rows = await queryTerminalHistory({
        prefix: input,
        projectId: context.projectId ?? null,
        cwd: context.cwd,
        limit: MAX_DURABLE_SUGGESTIONS + ring.length,
      })
      if (signal.aborted) return []
      // The durable query is case-insensitive; the suggestion contract is
      // append-only, so keep only rows that extend the input verbatim.
      durable = rows
        .map((r) => r.command)
        .filter((cmd) => cmd.startsWith(input) && cmd.length > input.length)
    } catch {
      durable = []
    }

    const seen = new Set<string>()
    const merged: string[] = []
    for (const cmd of [...ring, ...durable]) {
      if (seen.has(cmd)) continue
      seen.add(cmd)
      merged.push(cmd)
      if (merged.length >= MAX_HISTORY_SUGGESTIONS + MAX_DURABLE_SUGGESTIONS) break
    }

    return merged.map((cmd, i): TerminalCompletionSuggestion => ({
      text: cmd,
      source: "history",
      providerId: historyProvider.id,
      // Top match gets the top score, decaying with rank.
      score: Math.max(0.1, 0.9 - i * 0.1),
    }))
  },
}
