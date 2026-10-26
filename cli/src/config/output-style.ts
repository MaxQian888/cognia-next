/**
 * Output styles ("response modes", Claude Code parity). Each non-default style
 * appends a short instruction to the system prompt that tunes HOW the agent
 * answers (length, teaching tone, …) without changing WHAT it can do. Pure +
 * fully unit-tested; `to-build-context` composes the effective prompt and the
 * `/output-style` command flips `config.outputStyle`.
 */
import { CLI_OUTPUT_STYLE_PROMPTS } from "@/lib/agent/prompts/cli-prompts"
import { resolvePrompt } from "@/lib/prompts/resolve"
import type { PromptDefinitionV1, PromptResolutionContext } from "@/lib/prompts/types"
import { type OutputStyle } from "./schema"

/**
 * The Prompt Center slot behind each style (`default` ⇒ none). The bodies live
 * in `lib/` so the app's Prompt Center can edit them (ADR-0236).
 */
const OUTPUT_STYLE_PROMPTS: Record<OutputStyle, PromptDefinitionV1 | null> = {
  default: null,
  ...CLI_OUTPUT_STYLE_PROMPTS,
}

/**
 * The instruction for a style, or null for `default` / undefined. Synchronous:
 * it runs inside the option build, after the session primed the override
 * snapshot, so `context.workspaceId` is the workspace mounting the cwd.
 */
export function outputStyleInstruction(
  style: OutputStyle | undefined,
  context: PromptResolutionContext = {}
): string | null {
  if (!style) return null
  const def = OUTPUT_STYLE_PROMPTS[style]
  return def ? resolvePrompt(def, { context }).text : null
}

/**
 * Merge a base system prompt with the active output-style instruction. Returns
 * `undefined` when neither contributes anything (so the caller can omit the
 * field entirely rather than send an empty string).
 */
export function composeSystemPrompt(
  base: string | undefined,
  style: OutputStyle | undefined,
  context: PromptResolutionContext = {}
): string | undefined {
  const suffix = outputStyleInstruction(style, context)
  const trimmedBase = base?.trim() ? base : undefined
  if (trimmedBase && suffix) return `${trimmedBase}\n\n${suffix}`
  return trimmedBase ?? suffix ?? undefined
}
