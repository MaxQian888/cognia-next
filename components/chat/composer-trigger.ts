// Pure-function trigger detection for the chat composer's autocomplete popover.
// Given the current textarea value and caret position, decide whether the
// caret is inside a "/", "@", "!", or "#" token, and if so what the user has
// typed for that token. Lives outside any React component so it can be
// unit-tested without rendering.
//
// Rules (intentionally close to Claude Code's behaviour):
//   - `/cmd` counts at the start of any line. `!shell` and `#mem` only count
//     when they are the **first** non-whitespace characters of the textarea —
//     anywhere else they are regular characters (URLs, paths, math, hashtags).
//   - `@path` triggers anywhere as long as the `@` follows whitespace or the
//     line start. This skips email addresses (`user@host`).
//   - The token ends at the next whitespace; backspacing over the trigger
//     char dismisses the popover.

import { findTokenEnd, isMentionStart } from "@/lib/slash-commands/mention-boundary"

export type TriggerKind =
  "slash" | "file" | "bash" | "memory" | "agent" | "skill" | "preset" | "wfNode" | "wfEdge"

export type MentionMode = "files" | "agents" | "combined" | "workflow"

/**
 * A workflow graph element the copilot `@` picker can reference. Produced by
 * `useMentionableWorkflowElements` from the editor store and rendered by the
 * composer popover. Lives here (a pure, chat-side module) so neither the
 * composer nor the popover has to import from the workflow subsystem.
 */
export interface MentionableWorkflowElement {
  type: "node" | "edge"
  /** Graph-local id (`n_…` / `e_…`) inserted as `@node:<id>` / `@edge:<id>`. */
  id: string
  /** User-visible label (node label, or a derived edge label). */
  label: string
  /** Node kind (`ai.prompt`, …) or edge kind (`default` / `conditional` / …). */
  kind: string
  /** Optional secondary line — a containing-group breadcrumb or edge endpoints. */
  sublabel?: string
  /** Pre-lowercased haystack for fuzzy matching (id + label + kind + sublabel). */
  searchText: string
}

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
   *   - `"files"` (default) → file picker (workspace search).
   *   - `"agents"` → agent picker only (the agent-team workspace chat).
   *   - `"combined"` → general chat: ONE `@` panel listing subagents + files.
   *     The trigger kind stays `"file"` (so the async file search still runs);
   *     the popover prepends the subagent section. So both `"files"` and
   *     `"combined"` produce a `"file"` trigger — only `"agents"` differs.
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
const SKILL_TRIGGER: TriggerKind = "skill"
const PRESET_TRIGGER: TriggerKind = "preset"
const WFNODE_TRIGGER: TriggerKind = "wfNode"
const WFEDGE_TRIGGER: TriggerKind = "wfEdge"

// Namespaced `@` prefixes that flip the mention into a typed picker instead of
// the file/agent panel. Mirrors the CLI's `@skill:` / `@agent:` mention
// vocabulary (cli/src/tui/mention/detector.ts). The set is mode-dependent so
// `@node:` only means a workflow node inside the workflow-editor composer.
const CHAT_NAMESPACE_PREFIXES: ReadonlyArray<{ prefix: string; kind: TriggerKind }> = [
  { prefix: "skill:", kind: SKILL_TRIGGER },
  { prefix: "preset:", kind: PRESET_TRIGGER },
]
const WORKFLOW_NAMESPACE_PREFIXES: ReadonlyArray<{ prefix: string; kind: TriggerKind }> = [
  { prefix: "node:", kind: WFNODE_TRIGGER },
  { prefix: "edge:", kind: WFEDGE_TRIGGER },
]

function namespacePrefixesFor(
  mode: MentionMode | undefined
): ReadonlyArray<{ prefix: string; kind: TriggerKind }> {
  if (mode === "workflow") return WORKFLOW_NAMESPACE_PREFIXES
  // The team workspace (`agents`) reserves `@` for members — no typed prefixes.
  if (mode === "agents") return []
  return CHAT_NAMESPACE_PREFIXES
}

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

  // `!shell` / `#memory` remain whole-textarea MODES: they short-circuit the
  // entire submit, so they only count when they are the very first character
  // (no newline between start and caret).
  const firstChar = value[0]
  if (firstChar === "!" || firstChar === "#") {
    const firstNewline = value.indexOf("\n")
    const lineEnd = firstNewline === -1 ? value.length : firstNewline
    if (caret > lineEnd) return null
    const kind: TriggerKind = firstChar === "!" ? BASH_TRIGGER : MEMORY_TRIGGER
    // `!` and `#` treat the whole rest of the line as the query.
    return {
      kind: kind,
      tokenStart: 0,
      tokenEnd: lineEnd,
      query: value.slice(1, Math.min(caret, lineEnd)),
    }
  }

  // `/command` triggers at the start of ANY line (allowing leading whitespace),
  // so a single message can carry multiple commands. The command is anchored to
  // the caret's current line.
  {
    const lineStart = value.lastIndexOf("\n", caret - 1) + 1
    let slashPos = lineStart
    while (slashPos < value.length && value[slashPos] !== "\n" && /\s/.test(value[slashPos])) {
      slashPos++
    }
    if (value[slashPos] === "/" && caret >= slashPos) {
      const nextNewline = value.indexOf("\n", lineStart)
      const lineEnd = nextNewline === -1 ? value.length : nextNewline
      const tokenEnd = findTokenEnd(value, slashPos + 1, lineEnd)
      return {
        kind: SLASH_TRIGGER,
        tokenStart: slashPos,
        tokenEnd,
        query: value.slice(slashPos + 1, Math.min(caret, tokenEnd)),
      }
    }
  }

  // `@file` / `@agent` / `@node` trigger — search backwards from the caret for
  // an `@` whose left neighbour is whitespace or the start of input. Stop at
  // whitespace. The kind depends on the composer's `mentionMode`: the workflow
  // composer makes a bare `@` mean "workflow node".
  const atKind: TriggerKind =
    opts?.mentionMode === "workflow"
      ? WFNODE_TRIGGER
      : opts?.mentionMode === "agents"
        ? AGENT_TRIGGER
        : FILE_TRIGGER
  const namespacePrefixes = namespacePrefixesFor(opts?.mentionMode)
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i]
    if (ch === "@") {
      if (!isMentionStart(value, i)) {
        // Looks like an email or `path/@thing` — skip.
        return null
      }
      const queryEnd = findTokenEnd(value, i + 1, value.length)
      // If the caret has scrolled past the token end (user clicked elsewhere)
      // we still highlight the popover only when the caret is inside the
      // token range.
      if (caret > queryEnd) return null
      const beforeCaret = value.slice(i + 1, caret)
      // A typed namespace prefix (`@skill:` / `@preset:` in chat, `@node:` /
      // `@edge:` in the workflow composer) flips the panel into a dedicated
      // picker. The applicable set is chosen by mode above.
      for (const { prefix, kind } of namespacePrefixes) {
        if (beforeCaret.startsWith(prefix)) {
          return {
            kind,
            tokenStart: i,
            tokenEnd: queryEnd,
            query: beforeCaret.slice(prefix.length),
          }
        }
      }
      return {
        kind: atKind,
        tokenStart: i,
        tokenEnd: queryEnd,
        query: beforeCaret,
      }
    }
    if (/\s/.test(ch)) break
  }
  return null
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
