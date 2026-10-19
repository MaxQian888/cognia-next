import { PET_PROMPTS, buildPetSystemPrompt } from "./persona"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { PetBones, PetSoul } from "@/types/pet"
import { MEMORY_RECALL_PREAMBLE } from "@cognia/memory/runtime/recall-framing"

const soul: PetSoul = { name: "Boba", personality: "curious and gentle", hatchDate: "2026-01-01" }
const bones = { rarity: "rare", species: "axolotl" } as PetBones

/** The original `buildSystemPrompt` output from lib/pet/bubbles/speak.ts. */
function legacyPrompt(persona?: string): string {
  const personaLine = persona ? ` Your human's current persona is: ${persona}.` : ""
  return (
    `You are ${soul.name}, a ${bones.rarity} ${bones.species} desktop pet. ` +
    `Personality: ${soul.personality}.${personaLine} ` +
    `Reply in ONE short, playful sentence, in character. ` +
    `Never reveal or ask for personal data. Do not give long answers.`
  )
}

describe("buildPetSystemPrompt", () => {
  it("is byte-identical to the legacy prompt when no extras are supplied", () => {
    expect(buildPetSystemPrompt({ soul, bones })).toBe(legacyPrompt())
    expect(buildPetSystemPrompt({ soul, bones, persona: "a night-owl dev" })).toBe(
      legacyPrompt("a night-owl dev")
    )
  })

  it("appends the state layer with all four facts", () => {
    const out = buildPetSystemPrompt({
      soul,
      bones,
      state: { mood: "happy", energy: 72, bond: 44, level: 5 },
    })
    expect(out.startsWith(legacyPrompt())).toBe(true)
    expect(out).toContain("mood: happy")
    expect(out).toContain("energy: 72/100")
    expect(out).toContain("bond: 44/100")
    expect(out).toContain("level: 5")
  })

  it("includes history and recall only when non-empty", () => {
    const out = buildPetSystemPrompt({
      soul,
      bones,
      historyText: "User: hi\nYou: hey!",
      recallText: "- Loves matcha",
    })
    expect(out).toContain("Recent things you said together:\nUser: hi\nYou: hey!")
    // Same heading and data-only trust boundary as chat recall.
    expect(out).toContain(
      `## What you remember about the user\n${MEMORY_RECALL_PREAMBLE}\n- Loves matcha`
    )

    const without = buildPetSystemPrompt({ soul, bones, historyText: "", recallText: "" })
    expect(without).toBe(legacyPrompt())
  })

  it("adds the emotion protocol and locale lines on demand", () => {
    const out = buildPetSystemPrompt({ soul, bones, emotionInstruction: true, locale: "zh-CN" })
    expect(out).toContain("emotion tag in square brackets")
    expect(out).toContain("Reply in the user's language (zh-CN).")
  })

  it("swaps the reply guidance in conversational mode (and drops the one-line cap)", () => {
    const out = buildPetSystemPrompt({ soul, bones, conversational: true })
    expect(out).toContain("Reply conversationally and in character")
    expect(out).toContain("You may answer questions and be genuinely helpful")
    expect(out).not.toContain("ONE short, playful sentence")
    expect(out).not.toContain("Do not give long answers")
    // Identity + personality prefix is unchanged.
    expect(
      out.startsWith(`You are ${soul.name}, a ${bones.rarity} ${bones.species} desktop pet.`)
    ).toBe(true)
  })

  it("renders the full layered prompt byte-identically to the legacy assembly", () => {
    const out = buildPetSystemPrompt({
      soul,
      bones,
      persona: "a night-owl dev",
      state: { mood: "happy", energy: 72, bond: 44, level: 5 },
      historyText: "User: hi\nYou: hey!",
      locale: "zh-CN",
    })
    expect(out).toBe(
      [
        legacyPrompt("a night-owl dev"),
        "Your current state — mood: happy, energy: 72/100, bond: 44/100, level: 5. " +
          "Let your reply quietly reflect this state.",
        "Recent things you said together:\nUser: hi\nYou: hey!",
        "Reply in the user's language (zh-CN).",
      ].join("\n\n")
    )
  })

  describe("Prompt Center overrides", () => {
    afterEach(() => {
      __setPromptOverrideSnapshotForTests(null)
      __resetPromptVerdictsForTests()
    })

    function override(promptId: string, revisionId: string, body: string) {
      return {
        bindingId: `pob-${revisionId}`,
        promptId,
        scope: "account" as const,
        targetId: "",
        revisionId,
        body,
        contractVersion: 1,
      }
    }

    it("edits the scaffolding while the pet's identity stays data", () => {
      __setPromptOverrideSnapshotForTests(
        buildPromptOverrideSnapshot("test-db", [
          override(
            PET_PROMPTS.bubble.id,
            "por-pet-bubble",
            "I am {{name}} the {{species}}.{{personaLine}} Answer in one word."
          ),
          override(PET_PROMPTS.boundPersona.id, "por-pet-bound", " Owner: {{persona}}."),
          override(PET_PROMPTS.language.id, "por-pet-language", "Language: {{locale}}."),
        ])
      )
      const out = buildPetSystemPrompt({ soul, bones, persona: "a night-owl dev", locale: "en" })
      expect(out).toBe(
        "I am Boba the axolotl. Owner: a night-owl dev. Answer in one word.\n\nLanguage: en."
      )
    })

    it("reads an explicitly passed snapshot", () => {
      const snapshot = buildPromptOverrideSnapshot("test-db", [
        override(PET_PROMPTS.state.id, "por-pet-state", "Mood {{mood}}, level {{level}}."),
      ])
      const out = buildPetSystemPrompt(
        { soul, bones, state: { mood: "tired", energy: 1, bond: 2, level: 3 } },
        { snapshot }
      )
      expect(out).toBe(`${legacyPrompt()}\n\nMood tired, level 3.`)
    })
  })
})
