/**
 * Built-in offline completion provider: prefix-matches the session's
 * recent command history. Always available (no model, no network), so the
 * autocomplete feature degrades to fish/zsh-style history suggestion when
 * no LLM is configured or the AI provider is disabled.
 */

import type { TerminalCompletionProvider, TerminalCompletionSuggestion } from "./types"

const MAX_HISTORY_SUGGESTIONS = 3

export const historyProvider: TerminalCompletionProvider = {
  id: "builtin:history",
  label: "Command history",
  // Runs before the AI provider so an instant history hit can show while
  // the model call is still in flight; ranking still prefers AI on ties.
  priority: 10,
  getCompletions: async (context) => {
    const input = context.input
    if (input.trim().length === 0) return []

    const out: TerminalCompletionSuggestion[] = []
    const seen = new Set<string>()
    // Walk newest → oldest so the most recent match wins.
    for (let i = context.recentCommands.length - 1; i >= 0; i--) {
      const cmd = context.recentCommands[i]
      if (!cmd.startsWith(input) || cmd.length <= input.length) continue
      if (seen.has(cmd)) continue
      seen.add(cmd)
      out.push({
        text: cmd,
        source: "history",
        providerId: historyProvider.id,
        // Newest match gets the top score, decaying with age.
        score: 0.9 - out.length * 0.1,
      })
      if (out.length >= MAX_HISTORY_SUGGESTIONS) break
    }
    return out
  },
}
