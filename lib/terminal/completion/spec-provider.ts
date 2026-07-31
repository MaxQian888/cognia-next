/**
 * Built-in declarative spec completion provider (ADR-0039 phase 2):
 * subcommand + flag completion for common CLIs (git, npm, cargo, docker,
 * …) from the in-repo spec set. Pure and web-safe — no fs, no Tauri.
 *
 * Positional values the spec tree can't model (paths, branch names) yield
 * no candidates here and are left to the path/history providers.
 */

import { getSpec } from "./spec"
import { resolveSpec } from "./spec/resolve"
import { shellUsesBackslashEscapes, tokenAtCursor, tokenize } from "./tokenize"
import type { TerminalCompletionProvider, TerminalCompletionSuggestion } from "./types"

const MAX_SPEC_SUGGESTIONS = 8

export const specCompletionProvider: TerminalCompletionProvider = {
  id: "builtin:spec",
  label: "CLI flags & subcommands",
  priority: 15,
  getCompletions: async (context) => {
    const escapes = shellUsesBackslashEscapes(context.shell)
    const opts = { backslashEscapes: escapes }
    const tokens = tokenize(context.input, opts)
    if (tokens.length === 0) return []

    const at = tokenAtCursor(context.input, context.cursor, opts)
    if (!at || at.index === 0) return [] // head word is the exe provider's turf

    const spec = getSpec(tokens[0].value)
    if (!spec) return []

    const prior = tokens.slice(1, at.index).map((t) => t.value)
    const candidates = resolveSpec(spec, prior, at.token.value)

    return candidates.slice(0, MAX_SPEC_SUGGESTIONS).map((c, i): TerminalCompletionSuggestion => ({
      text: context.input.slice(0, at.token.start) + c.name,
      source: "spec",
      providerId: "builtin:spec",
      detail: c.kind,
      description: c.description,
      score: Math.max(0.1, 0.9 - i * 0.05),
      replace: { from: at.token.start, insert: c.name },
    }))
  },
}
