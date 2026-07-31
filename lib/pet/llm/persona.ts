// Layered system-prompt assembly for the pet LLM channel (VPet pattern: the
// pet's live state is injected as plain facts the model must reflect).
//
// Layer 1 (persona) reproduces the legacy `buildSystemPrompt` text from
// `lib/pet/bubbles/speak.ts` BYTE-FOR-BYTE when no extra layers are supplied —
// existing speak behavior (and its tests) are the compatibility lock.

import type { PetBones, PetMood, PetSoul } from "@/types/pet"
import { emotionInstructionLine } from "./emotion-tags"

export interface PetPromptState {
  /** Coarse mood bucket (derived from needs at the call site). */
  mood: PetMood
  /** 0–100 energy. */
  energy: number
  /** 0–100 bond. */
  bond: number
  level: number
}

export interface BuildPetSystemPromptInput {
  soul: PetSoul
  bones: PetBones
  /** Optional persona prose from a bound Character (legacy field). */
  persona?: string
  /** Layer 2 — live nurture state the reply should reflect. */
  state?: PetPromptState
  /** Layer 3 — formatted history lines ("User: …\nYou: …"). */
  historyText?: string
  /** Layer 4 — recalled user facts as "- fact" lines. */
  recallText?: string
  /** Teach the inline emotion-tag protocol. */
  emotionInstruction?: boolean
  /** BCP-47 tag of the user's UI language (proactive seeds are English). */
  locale?: string
  /**
   * Conversational mode for the multi-turn chat panel: the pet may give a few
   * short sentences and actually answer questions, instead of the one-line
   * bubble default. Absent/false keeps the legacy one-line persona (the
   * compatibility lock — byte-identical when every optional layer is absent).
   */
  conversational?: boolean
}

/** Matches `apply-memory-context.ts` so the pet and chat speak one format. */
const RECALL_HEADING = "## What you remember about the user"

/**
 * Legacy layer-1 text. The default (non-conversational) branch is kept
 * BYTE-IDENTICAL to the original speak prompt — `speak.test.ts` locks it.
 * Conversational mode swaps only the reply-length guidance.
 */
function personaLayer(input: BuildPetSystemPromptInput): string {
  const personaLine = input.persona ? ` Your human's current persona is: ${input.persona}.` : ""
  const replyGuidance = input.conversational
    ? `Reply conversationally and in character — a few short sentences at most. ` +
      `You may answer questions and be genuinely helpful, but stay playful and true to your personality. ` +
      `Never reveal or ask for personal data.`
    : `Reply in ONE short, playful sentence, in character. ` +
      `Never reveal or ask for personal data. Do not give long answers.`
  return (
    `You are ${input.soul.name}, a ${input.bones.rarity} ${input.bones.species} desktop pet. ` +
    `Personality: ${input.soul.personality}.${personaLine} ` +
    replyGuidance
  )
}

export function buildPetSystemPrompt(input: BuildPetSystemPromptInput): string {
  const sections: string[] = [personaLayer(input)]

  if (input.state) {
    sections.push(
      `Your current state — mood: ${input.state.mood}, energy: ${input.state.energy}/100, ` +
        `bond: ${input.state.bond}/100, level: ${input.state.level}. ` +
        `Let your reply quietly reflect this state.`
    )
  }

  if (input.historyText) {
    sections.push(`Recent things you said together:\n${input.historyText}`)
  }

  if (input.recallText) {
    sections.push(`${RECALL_HEADING}\n${input.recallText}`)
  }

  if (input.emotionInstruction) {
    sections.push(emotionInstructionLine())
  }

  if (input.locale) {
    sections.push(`Reply in the user's language (${input.locale}).`)
  }

  return sections.join("\n\n")
}
