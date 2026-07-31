// Inline emotion-tag protocol for pet LLM replies (Open-LLM-VTuber pattern).
// The persona prompt asks the model to BEGIN its reply with at most one
// `[tag]` from a fixed vocabulary; this module scans/strips it. Parsing is a
// bounded bracket-prefix scan — no regex backtracking — and never throws:
// an unknown token simply yields `emotion: null` with the text untouched.

import type { PetOneShot } from "@/types/pet"

export const EMOTION_VOCAB = [
  "happy",
  "excited",
  "sad",
  "surprised",
  "love",
  "sleepy",
  "wave",
] as const

export type PetEmotion = (typeof EMOTION_VOCAB)[number]

/** Emotion → one-shot animation. `excited` reuses the levelUp burst. */
export const EMOTION_TO_ONESHOT: Record<PetEmotion, PetOneShot> = {
  happy: "happy",
  excited: "levelUp",
  sad: "sad",
  surprised: "surprised",
  love: "love",
  sleepy: "sleepy",
  wave: "wave",
}

/** Longest tag + brackets; anything longer cannot be a legal tag. */
const MAX_TAG_SPAN = 16

const VOCAB_SET: ReadonlySet<string> = new Set(EMOTION_VOCAB)

export interface ParsedEmotion {
  /** Reply with a legal leading tag removed (trimmed). */
  cleanText: string
  /** The parsed emotion, or null (no tag / unknown token). */
  emotion: PetEmotion | null
}

/**
 * Parse a leading `[tag]` off a reply. Only the leading position is scanned —
 * mid-sentence brackets stay literal. Unknown tokens are kept visible rather
 * than silently swallowed (never destroy model output we don't understand).
 */
export function parseEmotion(raw: string): ParsedEmotion {
  const text = (raw ?? "").trim()
  if (!text.startsWith("[")) return { cleanText: text, emotion: null }

  const close = text.indexOf("]")
  if (close <= 1 || close >= MAX_TAG_SPAN) return { cleanText: text, emotion: null }

  const token = text.slice(1, close).trim().toLowerCase()
  if (!VOCAB_SET.has(token)) return { cleanText: text, emotion: null }

  return {
    cleanText: text.slice(close + 1).trim(),
    emotion: token as PetEmotion,
  }
}

/** The single prompt line that teaches the model the protocol. */
export function emotionInstructionLine(): string {
  return `You may begin your reply with at most one emotion tag in square brackets, chosen from: ${EMOTION_VOCAB.join(", ")}. Example: "[happy] Yay, we did it!"`
}
