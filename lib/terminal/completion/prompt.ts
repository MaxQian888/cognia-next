/**
 * Pure prompt construction + response sanitisation for the built-in
 * AI terminal completion provider. Kept separate from the provider so
 * the (fiddly) model-output cleanup is unit-testable without a model.
 */

import type { TerminalCompletionContext } from "./types"

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
