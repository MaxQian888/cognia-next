/**
 * Pure prompt construction + response sanitisation for the built-in
 * AI terminal completion provider. Kept separate from the provider so
 * the (fiddly) model-output cleanup is unit-testable without a model.
 */

import type { TerminalCompletionContext, TerminalCompletionSuggestion } from "./types"

/** Hard cap on a single suggested command line. */
export const MAX_SUGGESTION_LEN = 400
/** How many recent commands to feed the model as context. */
const RECENT_CONTEXT = 8

const SYSTEM_PROMPT = [
  "You are a shell command completion engine, like GitHub Copilot for the terminal.",
  "Given the user's shell, working directory, recent commands, and a partial command line,",
  "predict the single most likely full command line the user is about to type.",
  "Respond with ONLY that one command line — no markdown, no code fences, no backticks,",
  "no explanation, no leading prompt symbol. The output MUST begin with the partial input",
  "verbatim. If you cannot make a confident, useful completion, repeat the partial input unchanged.",
].join(" ")

/** Build the `{ system, prompt }` pair for `LlmClient.complete`. */
export function buildCompletionPrompt(context: TerminalCompletionContext): {
  system: string
  prompt: string
} {
  const lines: string[] = []
  lines.push(`Shell: ${context.shell} (${context.shellPath})`)
  lines.push(`Platform: ${context.platform}`)
  if (context.cwd) lines.push(`Directory: ${context.cwd}`)
  const recent = context.recentCommands.slice(-RECENT_CONTEXT).filter((c) => c.trim().length > 0)
  if (recent.length > 0) {
    lines.push("Recent commands:")
    for (const cmd of recent) lines.push(`  ${cmd}`)
  }
  lines.push("")
  lines.push("Partial command line to complete:")
  lines.push(context.input)
  return { system: SYSTEM_PROMPT, prompt: lines.join("\n") }
}

/** Strip ``` fences, leaving the inner text. */
function stripFences(raw: string): string {
  return raw.replace(/```[a-zA-Z0-9]*\n?/g, "").replace(/```/g, "")
}

/** Strip a leading shell-prompt echo from a single line. */
function stripPromptEcho(line: string): string {
  return line.replace(/^(?:PS[^>]*>|\$|#|>|❯|»)\s+/, "")
}

/**
 * Clean a raw model completion against the partial `input`, returning the
 * full suggested command line (which always starts with `input`), or
 * `null` when the model produced nothing useful.
 */
export function sanitizeCompletion(raw: string, input: string): string | null {
  if (!raw) return null
  const noFences = stripFences(raw)
  const firstLine = noFences.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (!firstLine) return null

  let cleaned = firstLine.trim()
  // Unwrap a fully back-ticked line.
  if (cleaned.startsWith("`") && cleaned.endsWith("`") && cleaned.length >= 2) {
    cleaned = cleaned.slice(1, -1).trim()
  }
  cleaned = stripPromptEcho(cleaned).trim()
  if (cleaned === "") return null

  let result: string
  if (cleaned.startsWith(input)) {
    result = cleaned
  } else if (input.startsWith(cleaned)) {
    // Model echoed only (part of) the prefix — nothing to add.
    return null
  } else {
    // Model returned just the continuation — graft it onto the input.
    result = input + cleaned
  }

  if (result.length > MAX_SUGGESTION_LEN) return null
  if (result.length <= input.length) return null
  if (result === input) return null
  return result
}

/** The ghost-text portion of `suggestion` shown after `input`. */
export function ghostSuffix(suggestion: string, input: string): string {
  return suggestion.startsWith(input) ? suggestion.slice(input.length) : ""
}

/** A validated, input-relative acceptance edit for one suggestion. */
export interface SuggestionEdit {
  /** Offset in the input where the replacement starts. */
  from: number
  /** The text written after erasing `input.slice(from)`. */
  insert: string
  /** The full line after acceptance (`input.slice(0, from) + insert`). */
  result: string
}

/**
 * Resolve a suggestion against the current `input` into the edit that
 * accepting it would apply, or `null` when the suggestion no longer
 * applies (stale, empty, or it would drop typed characters).
 *
 * Append-mode suggestions (no `replace`) must extend the input verbatim.
 * Replace-mode suggestions must keep the replaced span as a
 * case-insensitive prefix of `insert` — case correction is allowed,
 * silently discarding user keystrokes is not.
 */
export function resolveSuggestionEdit(
  input: string,
  suggestion: Pick<TerminalCompletionSuggestion, "text" | "replace">
): SuggestionEdit | null {
  const replace = suggestion.replace
  if (replace) {
    const from = Math.max(0, Math.floor(replace.from))
    // The span start sits beyond the current input — the candidate was
    // computed for a longer line (user backspaced past it). Stale.
    if (from > input.length) return null
    const insert = replace.insert
    if (!insert) return null
    const replaced = input.slice(from).toLowerCase()
    // A re-quoted completion legitimately prepends one quote character to
    // the typed token (`My F` → `"My Folder/`): compare against both the
    // raw insert and the insert with a single leading quote stripped.
    const insertLower = insert.toLowerCase()
    const dequotedLower = insertLower.replace(/^["']/, "")
    if (!insertLower.startsWith(replaced) && !dequotedLower.startsWith(replaced)) return null
    const result = input.slice(0, from) + insert
    if (result === input) return null
    return { from, insert, result }
  }
  if (suggestion.text.startsWith(input) && suggestion.text.length > input.length) {
    return {
      from: input.length,
      insert: suggestion.text.slice(input.length),
      result: suggestion.text,
    }
  }
  return null
}
