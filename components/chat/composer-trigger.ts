// Pure-function trigger detection for the chat composer's autocomplete popover.
// Given the current textarea value and caret position, decide whether the
// caret is inside a "/", "@", "!", or "#" token, and if so what the user has
// typed for that token. Lives outside any React component so it can be
// unit-tested without rendering.
//
// Rules (intentionally close to Claude Code's behaviour):
//   - `/cmd` and `!shell` and `#mem` only count when they are the **first**
//     non-whitespace characters of the textarea — anywhere else, a `/` or `!`
//     or `#` is a regular character (URLs, paths, math, hashtags).
//   - `@path` triggers anywhere as long as the `@` follows whitespace or the
//     line start. This skips email addresses (`user@host`).
//   - The token ends at the next whitespace; backspacing over the trigger
//     char dismisses the popover.

export type TriggerKind = "slash" | "file" | "bash" | "memory" | "agent"

export type MentionMode = "files" | "agents"

export interface ComposerTrigger {
  kind: TriggerKind
  /** Inclusive start of the token (the trigger char) in `value`. */
  tokenStart: number
  /** Exclusive end — equals caret unless the caret has moved past the token. */
  tokenEnd: number
  /** Text after the trigger char up to the caret (never includes the trigger). */
  query: string
}

export interface DetectTriggerOptions {
  /**
   * What `@` should mean in this composer:
   *   - `"files"` (default) → file picker (workspace search), as in the
   *     general chat.
   *   - `"agents"` → agent picker (used by the agent-team workspace chat).
   *
   * The token-boundary rules are identical; only the `kind` of the returned
   * trigger differs.
   */
  mentionMode?: MentionMode
}

const SLASH_TRIGGER: TriggerKind = "slash"
const FILE_TRIGGER: TriggerKind = "file"
const BASH_TRIGGER: TriggerKind = "bash"
const MEMORY_TRIGGER: TriggerKind = "memory"
const AGENT_TRIGGER: TriggerKind = "agent"

/**
 * Detect whether the caret in `value` is inside an autocomplete trigger token.
 * Returns null when no trigger applies.
 */
export function detectTrigger(
  value: string,
  caret: number,
  opts?: DetectTriggerOptions
): ComposerTrigger | null {
  if (caret < 0 || caret > value.length) return null

  // Whole-textarea triggers (only when the textarea starts with the char).
  // We allow `\r\n` or `\n` between the trigger and the caret, but not other
  // characters before it.
  const firstChar = value[0]
  if (firstChar === "/" || firstChar === "!" || firstChar === "#") {
    // Must be at the very start, and the caret can only be inside the first
    // line (no newline between start and caret).
    const firstNewline = value.indexOf("\n")
    const lineEnd = firstNewline === -1 ? value.length : firstNewline
    if (caret > lineEnd) return null
    const kind: TriggerKind =
      firstChar === "/" ? SLASH_TRIGGER : firstChar === "!" ? BASH_TRIGGER : MEMORY_TRIGGER
    // `/` filters by a single command word (stop at whitespace); `!` and `#`
    // treat the whole rest of the line as the query — they're not filtering
    // anything.
    const tokenEnd = kind === SLASH_TRIGGER ? findTokenEnd(value, 1, lineEnd) : lineEnd
    return {
      kind,
      tokenStart: 0,
      tokenEnd,
      query: value.slice(1, Math.min(caret, tokenEnd)),
    }
  }

  // `@file` / `@agent` trigger — search backwards from the caret for an `@`
  // whose left neighbour is whitespace or the start of input. Stop at
  // whitespace. The kind depends on the composer's `mentionMode`.
  const atKind: TriggerKind = opts?.mentionMode === "agents" ? AGENT_TRIGGER : FILE_TRIGGER
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i]
    if (ch === "@") {
      const prev = i === 0 ? "" : value[i - 1]
      if (prev !== "" && !/\s/.test(prev)) {
        // Looks like an email or `path/@thing` — skip.
        return null
      }
      const queryEnd = findTokenEnd(value, i + 1, value.length)
      // If the caret has scrolled past the token end (user clicked elsewhere)
      // we still highlight the popover only when the caret is inside the
      // token range.
      if (caret > queryEnd) return null
      return {
        kind: atKind,
        tokenStart: i,
        tokenEnd: queryEnd,
        query: value.slice(i + 1, caret),
      }
    }
    if (/\s/.test(ch)) break
  }
  return null
}

function findTokenEnd(value: string, start: number, hardEnd: number): number {
  for (let i = start; i < hardEnd; i++) {
    if (/\s/.test(value[i])) return i
  }
  return hardEnd
}

/**
 * Splice `replacement` into `value` between `tokenStart` and `tokenEnd`,
 * returning both the new value and the new caret position. Used by the
 * popover when the user picks a candidate.
 */
export function spliceToken(
  value: string,
  tokenStart: number,
  tokenEnd: number,
  replacement: string
): { value: string; caret: number } {
  const before = value.slice(0, tokenStart)
  const after = value.slice(tokenEnd)
  // Add a trailing space so the user can keep typing without rebuilding the
  // trigger — but only if there's nothing already.
  const needsSpace = !after.startsWith(" ") && !after.startsWith("\n")
  const insert = needsSpace ? `${replacement} ` : replacement
  return {
    value: before + insert + after,
    caret: before.length + insert.length,
  }
}
