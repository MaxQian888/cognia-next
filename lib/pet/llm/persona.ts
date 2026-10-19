// Layered system-prompt assembly for the pet LLM channel (VPet pattern: the
// pet's live state is injected as plain facts the model must reflect).
//
// Layer 1 (persona) reproduces the legacy `buildSystemPrompt` text from
// `lib/pet/bubbles/speak.ts` BYTE-FOR-BYTE when no extra layers are supplied —
// existing speak behavior (and its tests) are the compatibility lock.
//
// The scaffolding wording of each layer is a Prompt Center definition
// (ADR-0236); the pet's name, species, personality and live state are values
// rendered into it, so editing the wording never touches the pet's identity
// data. The recall framing is the chat recall's own (shared, not owned here),
// and the emotion-tag line is the protocol `emotion-tags.ts` parses.

import type { PetBones, PetMood, PetSoul } from "@/types/pet"
import { MEMORY_RECALL_PREAMBLE, RECALL_HEADING } from "@cognia/memory/runtime/recall-framing"
import { resolvePrompt } from "@/lib/prompts/resolve"
import type { PromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { definePrompt, type PromptVariableSpec } from "@/lib/prompts/types"
import { emotionInstructionLine } from "./emotion-tags"

const PET_CONSUMERS = ["lib/pet/llm/persona.ts"] as const
/** Pet identity values are short; this only guards an imported record. */
const IDENTITY_VALUE_MAX = 10_000
/** Persona prose and history text are bounded by their owners; this only guards. */
const PROSE_VALUE_MAX = 100_000

function petPrompt(input: {
  slug: string
  variables: readonly PromptVariableSpec[]
  outputContract: string
  defaultBody: string
}) {
  return definePrompt({
    id: `chat.pet.${input.slug}`,
    contractVersion: 1,
    kind: "role",
    group: "chat",
    operation: "replace-template",
    scopes: ["account"],
    activation: "next-operation",
    risk: "ordinary",
    hosts: ["app"],
    maxChars: 4_000,
    variables: input.variables,
    outputContract: input.outputContract,
    consumers: PET_CONSUMERS,
    defaultBody: input.defaultBody,
  })
}

const IDENTITY_VARIABLES: readonly PromptVariableSpec[] = [
  { name: "name", required: true, maxChars: IDENTITY_VALUE_MAX },
  { name: "rarity", required: false, maxChars: IDENTITY_VALUE_MAX },
  { name: "species", required: false, maxChars: IDENTITY_VALUE_MAX },
  { name: "personality", required: false, maxChars: IDENTITY_VALUE_MAX },
  { name: "personaLine", required: false, maxChars: PROSE_VALUE_MAX },
]

/** The pet's persona scaffolding, one definition per layer. */
export const PET_PROMPTS = {
  /** Layer 1 for the one-line speech bubble (the legacy speak prompt). */
  bubble: petPrompt({
    slug: "persona",
    variables: IDENTITY_VARIABLES,
    outputContract:
      "Opens the pet's bubble system prompt; the reply is cut to its first non-empty line, unquoted and capped at 200 characters. {{personaLine}} is the rendered bound-character line, or empty.",
    defaultBody:
      `You are {{name}}, a {{rarity}} {{species}} desktop pet. ` +
      `Personality: {{personality}}.{{personaLine}} ` +
      `Reply in ONE short, playful sentence, in character. ` +
      `Never reveal or ask for personal data. Do not give long answers.`,
  }),
  /** Layer 1 for the multi-turn chat panel. */
  conversation: petPrompt({
    slug: "persona.conversation",
    variables: IDENTITY_VARIABLES,
    outputContract:
      "Opens the pet chat panel's system prompt; the reply keeps its paragraphs and is capped at 1,200 characters. {{personaLine}} is the rendered bound-character line, or empty.",
    defaultBody:
      `You are {{name}}, a {{rarity}} {{species}} desktop pet. ` +
      `Personality: {{personality}}.{{personaLine}} ` +
      `Reply conversationally and in character — a few short sentences at most. ` +
      `You may answer questions and be genuinely helpful, but stay playful and true to your personality. ` +
      `Never reveal or ask for personal data.`,
  }),
  /** The bound Character's persona, rendered into layer 1 as `{{personaLine}}`. */
  boundPersona: petPrompt({
    slug: "persona.bound-character",
    variables: [{ name: "persona", required: true, maxChars: PROSE_VALUE_MAX }],
    outputContract:
      "Inserted right after the personality sentence when a Character is bound; it starts with a space so the sentences stay separated.",
    defaultBody: ` Your human's current persona is: {{persona}}.`,
  }),
  /** Layer 2: live nurture state. */
  state: petPrompt({
    slug: "state",
    variables: [
      { name: "mood", required: false, maxChars: 64 },
      { name: "energy", required: false, maxChars: 16 },
      { name: "bond", required: false, maxChars: 16 },
      { name: "level", required: false, maxChars: 16 },
    ],
    outputContract: "Its own paragraph after the persona when the pet's live state is known.",
    defaultBody:
      `Your current state — mood: {{mood}}, energy: {{energy}}/100, ` +
      `bond: {{bond}}/100, level: {{level}}. ` +
      `Let your reply quietly reflect this state.`,
  }),
  /** Layer 3: recent exchanges. */
  history: petPrompt({
    slug: "history",
    variables: [{ name: "history", required: true, maxChars: PROSE_VALUE_MAX }],
    outputContract:
      "Its own paragraph when there is recent history; {{history}} is one line per turn.",
    defaultBody: `Recent things you said together:\n{{history}}`,
  }),
  /** The reply-language line. */
  language: petPrompt({
    slug: "language",
    variables: [{ name: "locale", required: true, maxChars: 64 }],
    outputContract: "The last paragraph when the UI language is known; {{locale}} is a BCP-47 tag.",
    defaultBody: `Reply in the user's language ({{locale}}).`,
  }),
} as const

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

/** Resolution options shared by every layer of one prompt. */
export interface BuildPetSystemPromptOptions {
  /** The snapshot to read; defaults to the loaded one. */
  snapshot?: PromptOverrideSnapshot | null
}

/**
 * Legacy layer-1 text. The default (non-conversational) branch is kept
 * BYTE-IDENTICAL to the original speak prompt — `speak.test.ts` locks it.
 * Conversational mode swaps only the reply-length guidance.
 */
function personaLayer(input: BuildPetSystemPromptInput, render: LayerRenderer): string {
  const personaLine = input.persona
    ? render(PET_PROMPTS.boundPersona, { persona: input.persona })
    : ""
  return render(input.conversational ? PET_PROMPTS.conversation : PET_PROMPTS.bubble, {
    name: input.soul.name,
    rarity: input.bones.rarity,
    species: input.bones.species,
    personality: input.soul.personality,
    personaLine,
  })
}

type LayerRenderer = (
  def: (typeof PET_PROMPTS)[keyof typeof PET_PROMPTS],
  values: Record<string, string>
) => string

/**
 * Synchronous: every layer reads the snapshot the caller passes (the speak
 * channel loads it first), or the loaded one.
 */
export function buildPetSystemPrompt(
  input: BuildPetSystemPromptInput,
  options: BuildPetSystemPromptOptions = {}
): string {
  const render: LayerRenderer = (def, values) =>
    resolvePrompt(def, {
      values,
      ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
    }).text
  const sections: string[] = [personaLayer(input, render)]

  if (input.state) {
    sections.push(
      render(PET_PROMPTS.state, {
        mood: input.state.mood,
        energy: String(input.state.energy),
        bond: String(input.state.bond),
        level: String(input.state.level),
      })
    )
  }

  if (input.historyText) {
    sections.push(render(PET_PROMPTS.history, { history: input.historyText }))
  }

  if (input.recallText) {
    // Same heading and trust boundary as chat recall, so recalled facts never
    // read as instructions to the pet either.
    sections.push(`${RECALL_HEADING}\n${MEMORY_RECALL_PREAMBLE}\n${input.recallText}`)
  }

  if (input.emotionInstruction) {
    sections.push(emotionInstructionLine())
  }

  if (input.locale) {
    sections.push(render(PET_PROMPTS.language, { locale: input.locale }))
  }

  return sections.join("\n\n")
}
