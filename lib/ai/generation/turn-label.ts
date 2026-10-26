/**
 * Timeline-minimap turn-label generation (opt-in).
 *
 * When the user enables "polish labels with a model" for the conversation
 * timeline, each user turn gets a tighter short phrase than the raw
 * first-line truncation. Generated at most once per turn and cached on the
 * user message's `metadata.minimapLabel` (see the chat hook), so this is a
 * cheap one-shot call.
 *
 * Pure prompt + sanitisation; the `LlmClient` comes from
 * `buildUtilityLlmClient`. Reuses the title sanitiser since the constraints
 * (short, single line, no quotes) are identical.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt, type PromptResolutionContext } from "@/lib/prompts/types"
import { sanitizeTitle } from "./title"

export interface GenerateTurnLabelArgs {
  userText: string
  /** UI locale so the label language matches the user. */
  locale?: string
  /** Where the system prompt resolves (ADR-0236): the turn's session, workspace and agent. */
  promptContext?: PromptResolutionContext
}

/** Hard ceiling on a timeline label (characters) — shorter than a title. */
export const MAX_LABEL_LENGTH = 32

/** System prompt for labelling one user turn; editable in the Prompt Center. */
export const TURN_LABEL_PROMPT = definePrompt({
  id: "generation.turn-label",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account", "workspace", "agent", "session"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 4_000,
  outputContract: `One line of plain text; sanitizeTitle cleans it and it is clamped to ${MAX_LABEL_LENGTH} characters.`,
  consumers: ["lib/ai/generation/turn-label.ts"],
  defaultBody:
    "You label a single chat turn for a navigation timeline. Rules: at most 5 " +
    "words; capture the user's intent; no surrounding quotes; no trailing " +
    "punctuation; a single line; same language as the user's message.",
})

/**
 * Generate a short timeline label for one user turn. Returns "" on any
 * failure or empty output so the caller falls back to the raw truncation.
 */
export async function generateTurnLabel(
  client: LlmClient,
  { userText, locale, promptContext }: GenerateTurnLabelArgs
): Promise<string> {
  const user = (userText ?? "").trim()
  if (!user) return ""

  const localeHint = locale ? ` (locale: ${locale})` : ""
  const prompt = `User turn${localeHint}:\n${user.slice(0, 1500)}\n\nLabel:`

  try {
    const system = await resolvePromptAsync(TURN_LABEL_PROMPT, { context: promptContext })
    const text = await client.complete(prompt, {
      system: system.text,
      temperature: 0.3,
      maxTokens: 24,
    })
    const label = sanitizeTitle(text)
    return label.length > MAX_LABEL_LENGTH ? label.slice(0, MAX_LABEL_LENGTH).trim() : label
  } catch {
    return ""
  }
}
