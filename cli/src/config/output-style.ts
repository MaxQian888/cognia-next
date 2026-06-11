/**
 * Output styles ("response modes", Claude Code parity). Each non-default style
 * appends a short instruction to the system prompt that tunes HOW the agent
 * answers (length, teaching tone, …) without changing WHAT it can do. Pure +
 * fully unit-tested; `to-build-context` composes the effective prompt and the
 * `/output-style` command flips `config.outputStyle`.
 */
import { type OutputStyle } from "./schema"

/** The system-prompt suffix for each style (`default` ⇒ none). */
const OUTPUT_STYLE_PROMPTS: Record<OutputStyle, string | null> = {
  default: null,
  concise: [
    "Output style: Concise.",
    "Answer in as few words as correctness allows. Lead with the result, skip",
    "preamble and restating the question, and prefer short lists or single",
    "sentences over paragraphs. Only expand when the user asks for detail.",
  ].join(" "),
  explanatory: [
    "Output style: Explanatory.",
    "Alongside the solution, explain the reasoning and the trade-offs behind it —",
    "why this approach over the alternatives, and which assumptions it rests on —",
    "so the user understands not just what to do but why.",
  ].join(" "),
  learning: [
    "Output style: Learning.",
    "Act as a coding mentor. Break the work into steps, explain the underlying",
    "concepts as they come up, and where it helps the user learn, leave a clearly",
    "marked small piece for them to complete rather than writing every line.",
  ].join(" "),
}

/** The instruction for a style, or null for `default` / undefined. */
export function outputStyleInstruction(style: OutputStyle | undefined): string | null {
  if (!style) return null
  return OUTPUT_STYLE_PROMPTS[style] ?? null
}

/**
 * Merge a base system prompt with the active output-style instruction. Returns
 * `undefined` when neither contributes anything (so the caller can omit the
 * field entirely rather than send an empty string).
 */
export function composeSystemPrompt(
  base: string | undefined,
  style: OutputStyle | undefined
): string | undefined {
  const suffix = outputStyleInstruction(style)
  const trimmedBase = base?.trim() ? base : undefined
  if (trimmedBase && suffix) return `${trimmedBase}\n\n${suffix}`
  return trimmedBase ?? suffix ?? undefined
}
