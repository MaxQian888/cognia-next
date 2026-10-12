/**
 * Mention commands for comment-triggered Bots: `@bot verb args`.
 *
 * A comment is data written by whoever can comment on the repository, so the
 * grammar is narrow on purpose:
 *
 *  - the mention must open an unquoted line of live prose (not code, not a
 *    quote, not an HTML comment), so pasted examples and quoted replies never
 *    fire, and `me@bot.dev` or `@bot-fan` are not the Bot;
 *  - one command per comment: two live mentions are a usage error, never
 *    "the first one wins";
 *  - reserved verbs are refused by name rather than read as free text;
 *  - the arguments are returned as text, never split into anything a shell
 *    or a tool would interpret.
 *
 * What a verb means (task references, required arguments) is the Bot's own
 * business; this returns the verb and its raw arguments.
 */

import { blankHtmlComments, maskMarkdown, normalizeNewlines } from "./markdown"

export interface CommandGrammar {
  /** The mention that addresses the Bot, e.g. `@cognia-bot`. Case-insensitive. */
  trigger: string
  /** Verbs the Bot understands, lower case. */
  verbs: readonly string[]
  /** Verbs refused by name, lower case (e.g. `merge`, `approve`). */
  reservedVerbs?: readonly string[]
  /** The verb free text after the mention stands for; absent makes free text a usage error. */
  freeTextVerb?: string
  /** The verb a bare mention stands for (usually `help`). */
  bareVerb: string
  /** Largest accepted comment body, in UTF-8 bytes. */
  maxBytes: number
}

export type CommandParseFailure =
  "multiple_commands" | "reserved_verb" | "unknown_verb" | "too_large"

export type ParsedCommand =
  | { kind: "none" }
  | {
      kind: "command"
      verb: string
      /** Everything after the verb, HTML comments blanked, trimmed. */
      args: string
      /** The verb came from `freeTextVerb`, not from the comment. */
      aliased: boolean
    }
  | { kind: "invalid"; reason: CommandParseFailure; verb?: string }

const TRIGGER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
const LIVE_MENTION = /^ {0,3}(@[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?)(?=$|[\s:,])/

function mentionKey(mention: string): string {
  return mention.toLowerCase().replace(/\[bot\]$/, "")
}

/** Validate a configured trigger; GitHub logins are 1–39 of `[A-Za-z0-9-]`. */
export function isValidTrigger(trigger: string): boolean {
  return TRIGGER.test(trigger)
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

interface LiveMention {
  line: number
  /** Column just past the mention. */
  end: number
}

function liveMentions(masked: string, trigger: string): LiveMention[] {
  const key = mentionKey(trigger)
  const found: LiveMention[] = []
  masked.split("\n").forEach((line, index) => {
    const match = LIVE_MENTION.exec(line)
    if (match && mentionKey(match[1]) === key) {
      found.push({ line: index, end: (match.index ?? 0) + match[0].length })
    }
  })
  return found
}

export function parseCommand(body: string, grammar: CommandGrammar): ParsedCommand {
  if (!isValidTrigger(grammar.trigger)) throw new Error("Invalid command trigger")
  const text = normalizeNewlines(body)
  const mentions = liveMentions(maskMarkdown(text), grammar.trigger)
  if (mentions.length === 0) return { kind: "none" }
  if (mentions.length > 1) return { kind: "invalid", reason: "multiple_commands" }
  if (utf8Bytes(text) > grammar.maxBytes) return { kind: "invalid", reason: "too_large" }

  const { line, end } = mentions[0]
  // HTML comments are invisible on GitHub; what a reviewer cannot see must not
  // reach the Bot either. Code and quotes after the mention are kept: they are
  // the question's material.
  const unhidden = blankHtmlComments(text).split("\n")
  const rest = [unhidden[line].slice(end).replace(/^[:,]/, ""), ...unhidden.slice(line + 1)]
    .map((part) => part.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim()
  if (!rest) return { kind: "command", verb: grammar.bareVerb, args: "", aliased: false }
  const [word] = rest.split(/\s/, 1)
  const verb = word.toLowerCase()
  if (grammar.reservedVerbs?.includes(verb))
    return { kind: "invalid", reason: "reserved_verb", verb }
  if (grammar.verbs.includes(verb)) {
    return { kind: "command", verb, args: rest.slice(word.length).trim(), aliased: false }
  }
  if (grammar.freeTextVerb) {
    return { kind: "command", verb: grammar.freeTextVerb, args: rest, aliased: true }
  }
  return { kind: "invalid", reason: "unknown_verb", verb }
}
