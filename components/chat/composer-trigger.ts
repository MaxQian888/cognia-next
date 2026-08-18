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
//     `!`/`#` claim only their FIRST LINE: with the caret on a later line the
//     `/` and `@` rules take over again (they used to be suppressed for the
//     whole rest of the message, which silently killed both popovers).
//   - Same-line command chaining (`/compact /clear`, see `parse-segments.ts`
//     rule 2b) anchors the popover to the token the caret is in, as long as
//     every token before it also starts with `/`.
//   - `@path` triggers anywhere as long as the `@` follows whitespace or the
//     line start. This skips email addresses (`user@host`).
//   - The token ends at the next whitespace; backspacing over the trigger
//     char dismisses the popover.

import { findTokenEnd, isMentionStart } from "@/lib/slash-commands/mention-boundary"
import { tokenizeLine } from "@/lib/slash-commands/parse-segments"
import { docsProviderPrefixes } from "@/lib/docs-providers"

export type TriggerKind =
  "slash" | "file" | "bash" | "memory" | "agent" | "skill" | "preset" | "wfNode" | "wfEdge" | "doc"

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
  /**
   * The namespace prefix that produced this trigger (`"lark:"`, `"gdoc:"`),
   * when one did. Only `"doc"` triggers carry it — every other namespaced kind
   * maps 1:1 to a `TriggerKind`, but the document providers share one kind and
   * are told apart by which prefix the user typed.
   */
  namespace?: string
  /** Inclusive start of the token (the trigger char) in `value`. */
  tokenStart: number
  /** Exclusive end — equals caret unless the caret has moved past the token. */
  tokenEnd: number
  /** Text after the trigger char up to the caret (never includes the trigger). */
  query: string
  /** Inclusive start of the first slash-command argument, when the caret is in it. */
  argumentStart?: number
  /** Exclusive end of the first slash-command argument token. */
  argumentEnd?: number
  /** First argument text up to the caret, used for inline option completion. */
  argumentQuery?: string
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
  /**
   * True when at least one command name starts with `query` — used ONLY to
   * decide whether a SECOND `/token` on the line is a chained command or just a
   * path argument (`/add-dir /usr/local`). Optional: without it every
   * `/`-prefixed later token anchors, which is the purely syntactic behaviour.
   * Never consulted for the line's first token, so argument completion for
   * commands that take args is unaffected.
   */
  hasCommandPrefix?: (query: string) => boolean
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
const DOC_TRIGGER: TriggerKind = "doc"

// Namespaced `@` prefixes that flip the mention into a typed picker instead of
// the file/agent panel. Mirrors the CLI's `@skill:` / `@agent:` mention
// vocabulary (cli/src/tui/mention/detector.ts). The set is mode-dependent so
// `@node:` only means a workflow node inside the workflow-editor composer.
const STATIC_CHAT_NAMESPACE_PREFIXES: ReadonlyArray<{ prefix: string; kind: TriggerKind }> = [
  { prefix: "skill:", kind: SKILL_TRIGGER },
  { prefix: "preset:", kind: PRESET_TRIGGER },
]

/**
 * Chat namespace prefixes = the two static ones plus one per registered remote
 * document provider (`@lark:`, `@gdoc:`). Read from the registry on every call
 * rather than snapshotted at module load, so a test that resets the registry
 * does not leave this list stale.
 */
function chatNamespacePrefixes(): ReadonlyArray<{ prefix: string; kind: TriggerKind }> {
  return [
    ...STATIC_CHAT_NAMESPACE_PREFIXES,
    ...docsProviderPrefixes().map(({ prefix }) => ({ prefix, kind: DOC_TRIGGER })),
  ]
}
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
  return chatNamespacePrefixes()
}

/**
 * Start of the `/` token the popover should complete on the caret's line, or
 * null when the line has none.
 *
 * Base rule (unchanged): the line's FIRST token, and only when it starts with
 * `/` — a mid-line slash stays inert so URLs and paths are safe.
 *
 * Chaining (mirrors `parse-segments.ts` rule 2b): when the caret sits inside a
 * later token that itself starts with `/`, and every token before it also
 * starts with `/`, that token becomes the anchor instead — so `/compact /cl`
 * completes `cl` rather than treating it as `/compact`'s argument.
 *
 * Two deliberate limits:
 *   - The caret's own token must literally start with `/`. A caret in empty
 *     space after `/pet ` belongs to no token, so it falls back to the first
 *     token and the argument-completion branch keeps working.
 *   - Only tokens BEFORE the caret's token are checked. Requiring the whole
 *     line would break `/help /model opus` (the trailing `opus` would drag the
 *     anchor back to `/help`, and picking would then overwrite the wrong token).
 */
function slashAnchor(
  value: string,
  lineStart: number,
  lineEnd: number,
  caret: number,
  hasCommandPrefix?: (query: string) => boolean
): number | null {
  const tokens = tokenizeLine(value, lineStart, lineEnd)
  if (tokens.length === 0 || value[tokens[0].start] !== "/") return null

  const index = tokens.findIndex((tok) => caret >= tok.start && caret <= tok.end)
  if (index < 0) return tokens[0].start
  for (let j = 1; j <= index; j++) {
    if (value[tokens[j].start] !== "/") return tokens[0].start
  }
  if (index > 0 && hasCommandPrefix) {
    // Distinguish a chained command from a path argument: `/add-dir /usr/loc`
    // matches no command name, so keep the first-token anchor and let the
    // argument-completion branch handle it.
    const query = value.slice(tokens[index].start + 1, Math.min(caret, tokens[index].end))
    if (!hasCommandPrefix(query)) return tokens[0].start
  }
  return tokens[index].start
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

  // `!shell` / `#memory` are FIRST-LINE modes: they only count when the trigger
  // char is the very first character of the textarea, and they claim only that
  // first line. With the caret on a later line we deliberately fall THROUGH to
  // the `/` and `@` rules below rather than returning null — returning null is
  // what used to leave both popovers dead for the whole rest of the message.
  const firstChar = value[0]
  if (firstChar === "!" || firstChar === "#") {
    const firstNewline = value.indexOf("\n")
    const modeLineEnd = firstNewline === -1 ? value.length : firstNewline
    if (caret <= modeLineEnd) {
      const kind: TriggerKind = firstChar === "!" ? BASH_TRIGGER : MEMORY_TRIGGER
      // `!` and `#` treat the whole rest of the line as the query.
      return {
        kind: kind,
        tokenStart: 0,
        tokenEnd: modeLineEnd,
        query: value.slice(1, Math.min(caret, modeLineEnd)),
      }
    }
    // caret is past the first line → fall through.
  }

  // `/command` triggers at the start of ANY line (allowing leading whitespace),
  // so a single message can carry multiple commands. The command is anchored to
  // the caret's current line.
  {
    const lineStart = value.lastIndexOf("\n", caret - 1) + 1
    const nextNewline = value.indexOf("\n", lineStart)
    const lineEnd = nextNewline === -1 ? value.length : nextNewline
    const slashPos = slashAnchor(value, lineStart, lineEnd, caret, opts?.hasCommandPrefix)
    if (slashPos !== null && caret >= slashPos) {
      const tokenEnd = findTokenEnd(value, slashPos + 1, lineEnd)
      let argumentFields: Pick<ComposerTrigger, "argumentStart" | "argumentEnd" | "argumentQuery"> =
        {}
      if (caret > tokenEnd) {
        let argumentStart = tokenEnd
        while (argumentStart < lineEnd && /\s/.test(value[argumentStart])) {
          argumentStart++
        }
        const argumentEnd = findTokenEnd(value, argumentStart, lineEnd)
        if (caret <= argumentEnd) {
          argumentFields = {
            argumentStart,
            argumentEnd,
            argumentQuery: value.slice(argumentStart, caret),
          }
        }
      }
      return {
        kind: SLASH_TRIGGER,
        tokenStart: slashPos,
        tokenEnd,
        query: value.slice(slashPos + 1, Math.min(caret, tokenEnd)),
        ...argumentFields,
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
            ...(kind === DOC_TRIGGER ? { namespace: prefix } : {}),
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
