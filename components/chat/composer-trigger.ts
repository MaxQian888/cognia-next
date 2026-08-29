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
//     every token before it also starts with `/` — or is a link, which is inert
//     (rule 2c), so `https://… /clear` still completes.
//   - `@path` triggers anywhere as long as the `@` follows whitespace or the
//     line start. This skips email addresses (`user@host`).
//   - The token ends at the next whitespace; backspacing over the trigger
//     char dismisses the popover.

import { findTokenEnd, isMentionStart, isTriggerStart } from "@/lib/slash-commands/mention-boundary"
import { isHttpUrlToken } from "@/lib/chat/link-token"
import { tokenizeLine } from "@/lib/slash-commands/parse-segments"
import { docsProviderPrefixes } from "@/lib/docs-providers"
import { entityMentionPrefixes, entityMentionShortcuts } from "@/lib/chat/mentions/entity-sources"

export type TriggerKind =
  | "slash"
  | "file"
  | "bash"
  | "memory"
  | "agent"
  | "subagent"
  | "skill"
  | "preset"
  | "wfNode"
  | "wfEdge"
  | "doc"
  | "entity"

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
   * The namespace prefix that produced this trigger (`"lark:"`, `"issue:"`,
   * `"file:"`), when one did.
   *
   * Carried by the kinds where the prefix is still load-bearing AFTER
   * detection: `"doc"` and `"entity"` each cover several sources told apart
   * only by which prefix was typed, and `"file"` needs it to distinguish an
   * explicit `@file:` (files only) from a bare `@` (files + subagents). The
   * kinds that map 1:1 onto a `TriggerKind` do not set it.
   */
  namespace?: string
  /**
   * The command whose argument region this mention sits inside, e.g. `review`
   * for `/review @src/a|`.
   *
   * A mention inside a command's arguments returns a MENTION trigger (that is
   * the whole point — the file picker has to open there), which would otherwise
   * make the command hint bar stand down at exactly the moment the user is
   * typing the arguments it exists to describe. Carrying the name keeps the bar
   * up without giving the popover a second opinion about what it is completing.
   */
  withinCommand?: string
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
  /**
   * True when the caret has moved past everything this trigger could complete:
   * the command word is finished AND the caret is beyond its first argument
   * token. The command is still IDENTIFIED — the hint bar wants that while you
   * type the rest of the arguments — but there is nothing left to pick, so the
   * completion popover must stay shut.
   *
   * Without this the popover reopened on the FIRST command of a chain the
   * moment the caret sat in the trailing space (`/clear /resume ▮`), showing
   * "clear" in its search box and offering to overwrite `/clear` with whatever
   * you picked.
   */
  caretPastArgument?: boolean
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
  /**
   * Is this token a link? Defaults to {@link isHttpUrlToken}. The composer
   * widens it so a FOLDED link (`svenstaro/genact`, see `lib/chat/link-fold.ts`)
   * stays as inert as the URL it replaced — otherwise folding a link would kill
   * command completion on the same line.
   */
  isLinkToken?: (token: string) => boolean
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
const SUBAGENT_TRIGGER: TriggerKind = "subagent"
const ENTITY_TRIGGER: TriggerKind = "entity"

// Namespaced `@` prefixes that flip the mention into a typed picker instead of
// the file/agent panel. Mirrors the CLI's `@skill:` / `@agent:` mention
// vocabulary (cli/src/tui/mention/detector.ts). The set is mode-dependent so
// `@node:` only means a workflow node inside the workflow-editor composer.
const STATIC_CHAT_NAMESPACE_PREFIXES: ReadonlyArray<{ prefix: string; kind: TriggerKind }> = [
  { prefix: "skill:", kind: SKILL_TRIGGER },
  { prefix: "preset:", kind: PRESET_TRIGGER },
  // `file:` and `agent:` exist for parity with the CLI's mention vocabulary
  // (`cli/src/tui/mention/detector.ts`), which has always had both. Bare `@`
  // still means "files and subagents together"; these two narrow it, which is
  // the only way to reach a file whose name happens to match a subagent handle
  // (and vice versa).
  { prefix: "file:", kind: FILE_TRIGGER },
  { prefix: "agent:", kind: SUBAGENT_TRIGGER },
]

/** Prefixes whose `namespace` the popover still needs after detection. */
const NAMESPACE_CARRYING_KINDS: ReadonlySet<TriggerKind> = new Set([
  DOC_TRIGGER,
  ENTITY_TRIGGER,
  FILE_TRIGGER,
])

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
    ...entityMentionPrefixes().map(({ prefix }) => ({ prefix, kind: ENTITY_TRIGGER })),
  ]
}
const WORKFLOW_NAMESPACE_PREFIXES: ReadonlyArray<{ prefix: string; kind: TriggerKind }> = [
  { prefix: "node:", kind: WFNODE_TRIGGER },
  { prefix: "edge:", kind: WFEDGE_TRIGGER },
]

/**
 * Single-character shortcuts, in the modes where a typed namespace applies.
 *
 * Read from the registry per call, exactly like the prefixes: a test that
 * resets the registry must not leave this list stale. Empty for the workflow
 * and team composers, where `@` already means something else and a second
 * symbol would mean a third thing.
 */
function shortcutsFor(mode: MentionMode | undefined) {
  if (mode === "workflow" || mode === "agents") return []
  return entityMentionShortcuts()
}

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
 * Links (rule 2c) are inert: a `https://…` token neither anchors nor breaks a
 * chain, so a message that opens with a pasted URL can still take a command.
 *
 * Two deliberate limits:
 *   - The caret's own token must literally start with `/`. A caret in empty
 *     space after `/pet ` belongs to no token, so it falls back to the first
 *     command token and the argument-completion branch keeps working.
 *   - Only tokens BEFORE the caret's token are checked. Requiring the whole
 *     line would break `/help /model opus` (the trailing `opus` would drag the
 *     anchor back to `/help`, and picking would then overwrite the wrong token).
 */
function slashAnchor(
  value: string,
  lineStart: number,
  lineEnd: number,
  caret: number,
  hasCommandPrefix?: (query: string) => boolean,
  isLinkToken: (token: string) => boolean = isHttpUrlToken
): number | null {
  const tokens = tokenizeLine(value, lineStart, lineEnd)
  if (tokens.length === 0) return null
  const isLink = (index: number): boolean =>
    isLinkToken(value.slice(tokens[index].start, tokens[index].end))

  // Leading links are inert context (parse-segments rule 2c): `<url> /cl` still
  // completes `cl`. Anything else before the first `/` token is prose.
  let first = 0
  while (first < tokens.length && isLink(first)) first++
  if (first >= tokens.length || value[tokens[first].start] !== "/") return null

  const index = tokens.findIndex((tok) => caret >= tok.start && caret <= tok.end)
  if (index <= first) return tokens[first].start
  for (let j = first + 1; j <= index; j++) {
    if (value[tokens[j].start] !== "/" && !isLink(j)) return tokens[first].start
  }
  // The caret's OWN token has to be a command word — a caret inside a trailing
  // link belongs to the first command's argument region, not to a new command.
  if (value[tokens[index].start] !== "/" || isLink(index)) return tokens[first].start
  if (hasCommandPrefix) {
    // Distinguish a chained command from a path argument: `/add-dir /usr/loc`
    // matches no command name, so keep the first-token anchor and let the
    // argument-completion branch handle it.
    const query = value.slice(tokens[index].start + 1, Math.min(caret, tokens[index].end))
    if (!hasCommandPrefix(query)) return tokens[first].start
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
    const slashPos = slashAnchor(
      value,
      lineStart,
      lineEnd,
      caret,
      opts?.hasCommandPrefix,
      opts?.isLinkToken
    )
    if (slashPos !== null && caret >= slashPos) {
      const tokenEnd = findTokenEnd(value, slashPos + 1, lineEnd)
      // A mention inside the command's ARGUMENTS wins over the command itself.
      //
      // Without this the `@` picker was unreachable on any line starting with
      // `/`: the slash branch returned first, and `hasSlashCompletion` then
      // closed the panel for every command that declares no `argumentOptions`.
      // So `/review @src/a` could be typed but never completed — while the send
      // path (`resolve-mentions.ts`, which parses with `isKnownCommand: () =>
      // false`) has always resolved mentions in command arguments. Completion
      // now agrees with resolution.
      //
      // Scoped to `> tokenEnd` so the command WORD is never scanned, and the
      // command name rides along on `withinCommand` so the hint bar stays up.
      if (caret > tokenEnd) {
        const commandName = value.slice(slashPos + 1, tokenEnd)
        // A shortcut inside a command's arguments resolves by the same rules a
        // mention there does — `/review ^` must complete, or the two trigger
        // characters would disagree about where they work.
        const mention =
          detectMentionAt(value, caret, opts, tokenEnd, commandName) ??
          detectShortcutAt(value, caret, opts, tokenEnd, commandName)
        if (mention) return mention
      }
      let argumentFields: Pick<
        ComposerTrigger,
        "argumentStart" | "argumentEnd" | "argumentQuery" | "caretPastArgument"
      > = {}
      if (caret > tokenEnd) {
        let argumentStart = tokenEnd
        while (argumentStart < lineEnd && /\s/.test(value[argumentStart])) {
          argumentStart++
        }
        const argumentEnd = findTokenEnd(value, argumentStart, lineEnd)
        argumentFields =
          caret <= argumentEnd
            ? {
                argumentStart,
                argumentEnd,
                argumentQuery: value.slice(argumentStart, caret),
              }
            : // Past the first argument: the command is still the one being
              // edited (the hint bar keeps showing it) but nothing here is
              // completable.
              { caretPastArgument: true }
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

  return detectMentionAt(value, caret, opts) ?? detectShortcutAt(value, caret, opts)
}

/**
 * The `^…` half: a registry-declared single character that opens one source's
 * panel with no namespace to type.
 *
 * Deliberately AFTER the `@` scan and after the slash branch, so a shortcut
 * character inside a mention or a command argument stays literal — `@a^b` is
 * one path, not a mention with a result picker inside it.
 *
 * The result is spelled as an ordinary namespaced entity trigger, so the
 * popover, the pick handler and the staging path need no shortcut branch at
 * all: `^` is a second door onto the same source, not a second mechanism.
 */
function detectShortcutAt(
  value: string,
  caret: number,
  opts?: DetectTriggerOptions,
  minStart = 0,
  withinCommand?: string
): ComposerTrigger | null {
  const shortcuts = shortcutsFor(opts?.mentionMode)
  if (shortcuts.length === 0) return null
  for (let i = caret - 1; i >= minStart; i--) {
    const ch = value[i]
    const match = shortcuts.find((s) => s.shortcut === ch)
    if (match) {
      if (!isTriggerStart(value, i, ch)) return null
      const queryEnd = findTokenEnd(value, i + 1, value.length)
      if (caret > queryEnd) return null
      return {
        kind: ENTITY_TRIGGER,
        namespace: match.prefix,
        tokenStart: i,
        tokenEnd: queryEnd,
        query: value.slice(i + 1, caret),
        ...(withinCommand ? { withinCommand } : {}),
      }
    }
    if (/\s/.test(ch)) break
  }
  return null
}

/**
 * The `@…` half of {@link detectTrigger}, callable on its own so a mention
 * inside a slash command's argument region resolves by the identical rules.
 *
 * Searches backwards from the caret for an `@` whose left neighbour is
 * whitespace or the start of the scanned region, stopping at whitespace. The
 * bare-`@` kind depends on the composer's `mentionMode`: the workflow composer
 * makes a bare `@` mean "workflow node", the team workspace makes it a member.
 *
 * `minStart` bounds the backwards walk. It is the command word's end when
 * scanning inside a command's arguments, so the scan can never reach back over
 * `/review` and mistake part of the command for a mention token.
 */
function detectMentionAt(
  value: string,
  caret: number,
  opts?: DetectTriggerOptions,
  minStart = 0,
  withinCommand?: string
): ComposerTrigger | null {
  const atKind: TriggerKind =
    opts?.mentionMode === "workflow"
      ? WFNODE_TRIGGER
      : opts?.mentionMode === "agents"
        ? AGENT_TRIGGER
        : FILE_TRIGGER
  const namespacePrefixes = namespacePrefixesFor(opts?.mentionMode)
  const commandField = withinCommand ? { withinCommand } : {}
  for (let i = caret - 1; i >= minStart; i--) {
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
      // A typed namespace prefix (`@skill:` / `@preset:` / `@file:` / `@agent:`
      // / a document provider / an entity source in chat, `@node:` / `@edge:`
      // in the workflow composer) flips the panel into a dedicated picker. The
      // applicable set is chosen by mode above.
      for (const { prefix, kind } of namespacePrefixes) {
        if (beforeCaret.startsWith(prefix)) {
          return {
            kind,
            tokenStart: i,
            tokenEnd: queryEnd,
            query: beforeCaret.slice(prefix.length),
            ...(NAMESPACE_CARRYING_KINDS.has(kind) ? { namespace: prefix } : {}),
            ...commandField,
          }
        }
      }
      return {
        kind: atKind,
        tokenStart: i,
        tokenEnd: queryEnd,
        query: beforeCaret,
        ...commandField,
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
