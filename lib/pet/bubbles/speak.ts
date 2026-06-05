// Opt-in LLM "speak" — runs ONLY on an explicit user action (click the pet /
// @mention it). It is a complete side channel to the main model: a separate
// utility client, its own tiny token budget, and a hard PII gate on the user's
// text before anything is sent. Any failure returns null and the pet just stays
// quiet — the user's real conversation is never affected.

import type { LlmClient } from "@/lib/twin/distill/llm"
import type { PetBones, PetSoul } from "@/types/pet"
import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"
import { buildPetSystemPrompt, type PetPromptState } from "@/lib/pet/llm/persona"

const MAX_REPLY = 200

export interface SpeakArgs {
  soul: PetSoul
  bones: PetBones
  /** What the user said to the pet (e.g. after `@Boba ...`). */
  userText: string
  /** Optional persona prose from a bound Character to colour the voice. */
  persona?: string
  /** Optional prompt layers (lib/pet/llm/persona.ts). When ALL are absent the
   *  system prompt is byte-identical to the original — the compatibility lock. */
  state?: PetPromptState
  historyText?: string
  recallText?: string
  emotionInstruction?: boolean
  locale?: string
}

/** Trim a raw reply to a single short, quote-free line. */
export function sanitizeReply(raw: string): string {
  let s = (raw ?? "").trim()
  if (!s) return ""
  s =
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  s = s.replace(/^["'`“”]+/, "").replace(/["'`“”]+$/, "")
  if (s.length > MAX_REPLY) s = s.slice(0, MAX_REPLY).trim()
  return s
}

function buildSystemPrompt(args: SpeakArgs): string {
  return buildPetSystemPrompt({
    soul: args.soul,
    bones: args.bones,
    persona: args.persona,
    state: args.state,
    historyText: args.historyText,
    recallText: args.recallText,
    emotionInstruction: args.emotionInstruction,
    locale: args.locale,
  })
}

/**
 * Speak as the pet. Returns the reply, or null if the client is missing, the
 * user text trips the PII gate, the model errors, or the output is empty.
 */
export async function speakAsPet(
  client: LlmClient | null,
  args: SpeakArgs
): Promise<string | null> {
  if (!client) return null
  const text = (args.userText ?? "").trim()
  if (!text) return null
  // Hard PII gate: never forward text that could leak personal data.
  if (!hasNoLeakingPii(text)) return null
  try {
    const raw = await client.complete(text.slice(0, 500), {
      system: buildSystemPrompt(args),
      temperature: 0.9,
      maxTokens: 80,
    })
    const reply = sanitizeReply(raw)
    return reply || null
  } catch {
    return null
  }
}
