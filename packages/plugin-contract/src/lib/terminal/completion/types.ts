/**
 * Terminal AI autocomplete — shared types.
 *
 * The integrated terminal (ADR-0031/0033) gains a GitHub-Copilot-style
 * inline suggestion engine (ADR-0039). As the user types at a shell
 * prompt, a debounced query fans out to a set of *completion providers*
 * (a built-in history heuristic, a built-in LLM provider, and any
 * plugin-contributed providers). The top-ranked suggestion is rendered
 * as dim "ghost text" after the cursor; Tab / → accepts it (writing the
 * remaining suffix into the PTY — it never auto-runs), Esc dismisses.
 *
 * Everything in `lib/terminal/completion/` is renderer-pure (no xterm,
 * no React) so the ranking, prompting, line-tracking, and gating logic
 * is unit-testable in isolation. The React glue lives in
 * `hooks/terminal/use-terminal-autocomplete.ts` +
 * `components/terminal/terminal-ghost-text.tsx`.
 */

import type { ShellKind } from "../shell-detect"

export interface TerminalCompletionContext {
  /** The terminal session id the suggestion is for. */
  sessionId: string
  /** Shell family, derived from the session's shell binary. */
  shell: ShellKind
  /** Raw shell binary path/name (e.g. `pwsh.exe`, `/bin/zsh`). */
  shellPath: string
  /** Current working directory, or null if not yet known. */
  cwd: string | null
  /** The partial command typed so far at the current prompt. */
  input: string
  /** Cursor offset within `input` (always === input.length when suggestible). */
  cursor: number
  /** Recent command lines for this session, oldest → newest. */
  recentCommands: string[]
  /** Platform hint so providers can prefer platform-correct syntax. */
  platform: "windows" | "macos" | "linux" | "other"
  /** Owning project id, or null — lets providers boost project-local data. */
  projectId?: string | null
}

export interface TerminalCompletionSuggestion {
  /** The full suggested command line (the line after acceptance). */
  text: string
  /** Where it came from — drives ranking + the ghost-text source badge. */
  source: "history" | "ai" | "plugin" | "path" | "exe" | "spec"
  /** Provider id (`builtin:history`, `builtin:ai`, or `<pluginId>:<defId>`). */
  providerId: string
  /** Optional short human label shown beside the ghost text (e.g. "git"). */
  detail?: string
  /** Optional longer description rendered in the candidate popup. */
  description?: string
  /**
   * Relative confidence in [0,1]. Used as the secondary ranking key after
   * source priority. Providers that can't estimate should omit it (treated
   * as 0.5).
   */
  score?: number
  /** Token-replacement span (see interface docs). Omitted → append mode. */
  replace?: { from: number; insert: string }
}

export interface AcceptEdit {
  backspaces: number
  write: string
}

export interface TerminalCompletionProvider {
  /** Stable id, unique across all providers. */
  id: string
  /** Human label for settings / the source badge. */
  label: string
  /** Lower runs first; ties broken by registration order. Default 100. */
  priority?: number
  getCompletions(
    context: TerminalCompletionContext,
    signal: AbortSignal
  ): Promise<TerminalCompletionSuggestion[]>
}

export const SOURCE_PRIORITY: Record<TerminalCompletionSuggestion["source"], number> = {
  plugin: 6,
  spec: 5,
  ai: 4,
  path: 3,
  exe: 2,
  history: 1,
}
