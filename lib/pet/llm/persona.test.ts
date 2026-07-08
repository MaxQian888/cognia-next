import { buildPetSystemPrompt } from "./persona"
import type { PetBones, PetSoul } from "@/types/pet"

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
    expect(out).toContain("## What you remember about the user\n- Loves matcha")

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
})
