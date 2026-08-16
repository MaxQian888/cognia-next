/**
 * Shared inline-completion contracts — the single vocabulary behind BOTH
 * composers' "ghost text":
 *
 *   - the desktop chat composer (`components/chat/composer.tsx`, via
 *     `hooks/chat/use-composer-ghost-text.ts`), and
 *   - the CLI TUI composer (`cli/src/tui/components/Input.tsx`).
 *
 * Deliberately modelled on the terminal's proven completion registry
 * (`lib/terminal/completion/types.ts`): a set of independent *providers* fan
 * out over one context, each returning zero or more full-draft suggestions,
 * which are then deduped and ranked by source priority. The difference is that
 * a chat composer has no PTY line model — the draft is fully known — so
 * suggestions here are always plain "the draft after acceptance" strings and
 * acceptance is a pure string write (never a byte stream).
 *
 * Everything in `lib/chat/completion/inline/` is renderer-pure: no React, no
 * Ink, no DOM, no direct model access. That is what lets the CLI import it
 * unchanged (the CLI already resolves `@/lib/*`), so both surfaces share one
 * ranking + debounce + cache implementation instead of two drifting copies.
 */

import type { GhostMessage } from "../ghost-prompt"

/**
 * Where a suggestion came from. Drives ranking (see
 * {@link INLINE_SOURCE_PRIORITY}) and the small source badge the composers
 * render beside the ghost text.
 *
 *  - `history` — a prior submitted draft from this session's ring.
 *  - `command` — a registered slash command name.
 *  - `ai`      — a single-shot LLM continuation.
 *  - `agent`   — produced by an agent/tool-using run (richer, slower than `ai`).
 *  - `plugin`  — contributed by a plugin-registered provider.
 */
export type InlineSuggestionSource = "history" | "command" | "ai" | "agent" | "plugin"

/**
 * One inline suggestion.
 *
 * `text` is the FULL draft that results from accepting it — not just the
 * suffix. This mirrors `TerminalCompletionSuggestion.text` so the two
 * subsystems read the same way, and it keeps providers honest: a provider that
 * cannot express its idea as "the whole draft afterwards" is proposing an edit,
 * not a completion, and belongs in a popup instead.
 *
 * Suggestions are append-only: {@link rankInlineSuggestions} drops any whose
 * `text` is not a strict extension of the draft, so the ghost is always the
 * dim tail after the caret and accepting can never rewrite typed characters.
 */
export interface InlineSuggestion {
  /** The complete draft after acceptance (always extends the context draft). */
  text: string
  /** Origin — ranking key and badge label source. */
  source: InlineSuggestionSource
  /** Stable provider id (`builtin:history`, `builtin:ai`, `<pluginId>:<defId>`). */
  providerId: string
  /** Short badge rendered beside the ghost (e.g. `"history"`, `"AI"`). */
  detail?: string
  /** Longer description, shown when a surface lists candidates rather than one ghost. */
  description?: string
  /**
   * Relative confidence in [0,1] — the secondary ranking key after source
   * priority. Providers that cannot estimate should omit it; ranking treats an
   * absent score as {@link DEFAULT_INLINE_SCORE}.
   */
  score?: number
}

/** A slash command a {@link InlineCompletionProvider} may complete against. */
export interface InlineCommandInfo {
  /** Command name WITHOUT the leading slash (e.g. `"compact"`). */
  name: string
  /** One-line description, used as the suggestion's `description`. */
  description?: string
  /** Alternate names, also completed. */
  aliases?: readonly string[]
}

/**
 * The context every provider receives. Assembled by the surface (React hook or
 * Ink component) from its own state; all fields beyond `draft`/`caret` are
 * best-effort, so a provider must tolerate empty history and absent messages.
 */
export interface InlineCompletionContext {
  /** The full text currently in the composer. */
  draft: string
  /**
   * Caret offset within `draft`. Surfaces only request completions when the
   * caret is at the end, so this equals `draft.length` in practice — it is
   * carried so a provider can assert that rather than assume it.
   */
  caret: number
  /** Previously submitted drafts, NEWEST FIRST. May be empty. */
  history: readonly string[]
  /** Slash commands available in this surface. May be empty. */
  commands: readonly InlineCommandInfo[]
  /** Recent conversation turns (most-recent last) for LLM continuity. */
  recentMessages?: readonly GhostMessage[]
  /** Which composer is asking — lets a provider tune its prompt or opt out. */
  surface: "gui" | "tui"
  /** Owning chat session id, when the surface has one. */
  sessionId?: string | null
  /** Working directory, when meaningful (the TUI always has one). */
  cwd?: string | null
}

/**
 * A completion provider.
 *
 * Providers MUST NOT throw — the engine isolates errors, but returning `[]` is
 * the contract for "nothing to suggest". Async providers MUST honour the
 * `AbortSignal` and abandon in-flight work when it fires.
 *
 * `sync: true` marks a provider as cheap and instantaneous (pure computation
 * over the context — history, command names). The engine runs those on every
 * keystroke with no debounce so the ghost appears immediately, and reserves the
 * debounce + cache for the async ones (model calls). See `engine.ts`.
 */
export interface InlineCompletionProvider {
  /** Stable id, unique across all providers on a surface. */
  id: string
  /** Human label for settings / diagnostics. */
  label: string
  /** Lower runs first; ties broken by registration order. Default 100. */
  priority?: number
  /**
   * True when `getCompletions` resolves without I/O and is cheap enough to run
   * on every keystroke. Such providers are queried un-debounced. Default false.
   */
  sync?: boolean
  getCompletions(context: InlineCompletionContext, signal: AbortSignal): Promise<InlineSuggestion[]>
}

/**
 * Source-priority weights for ranking (higher wins). An agent-backed
 * suggestion outranks a plain single-shot LLM one because it had more context
 * to work with; both outrank the purely mechanical local sources. Plugins sit
 * on top so a user-installed provider can deliberately take precedence.
 */
export const INLINE_SOURCE_PRIORITY: Record<InlineSuggestionSource, number> = {
  plugin: 5,
  agent: 4,
  ai: 3,
  command: 2,
  history: 1,
}

/** Score assumed for a suggestion that omits `score`. */
export const DEFAULT_INLINE_SCORE = 0.5

/** Default cap on how many ranked candidates the engine keeps for cycling. */
export const DEFAULT_INLINE_MAX_CANDIDATES = 5
