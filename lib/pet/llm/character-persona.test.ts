import { composePersonaLine, resolveCharacterPersona } from "./character-persona"
import type { Character } from "@cognia/agent-config-types"

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Mentor",
    avatarColor: "#000",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("composePersonaLine", () => {
  it("composes personality first, then tone, then voice summary", () => {
    const line = composePersonaLine(
      { personality: "Warm mentor who prefers analogies", tone: "gentle" },
      "Writes in short, encouraging sentences."
    )
    expect(line).toBe(
      "Warm mentor who prefers analogies; tone: gentle; Writes in short, encouraging sentences."
    )
  })

  it("returns empty string when nothing usable is present", () => {
    expect(composePersonaLine(undefined, undefined)).toBe("")
    expect(composePersonaLine({ personality: "  ", tone: "" }, "   ")).toBe("")
  })

  it("includes only the parts that exist", () => {
    expect(composePersonaLine({ tone: "playful" }, undefined)).toBe("tone: playful")
    expect(composePersonaLine(undefined, "concise and direct")).toBe("concise and direct")
  })

  it("caps the composed line to the max length", () => {
    const long = "x".repeat(500)
    const line = composePersonaLine({ personality: long }, undefined, 100)
    expect(line.length).toBeLessThanOrEqual(100)
  })
})

describe("resolveCharacterPersona", () => {
  it("resolves persona prose from the character metadata", async () => {
    const out = await resolveCharacterPersona("char_1", {
      loadCharacter: async () =>
        makeCharacter({ persona: { personality: "Curious tinkerer", tone: "warm" } }),
      loadTwinProfile: async () => undefined,
    })
    expect(out).toBe("Curious tinkerer; tone: warm")
  })

  it("appends the stored twin voice summary when the character is twin-bound", async () => {
    const loadTwinProfile = jest.fn(async () => ({ voiceSummary: "Replies tersely." }))
    const out = await resolveCharacterPersona("char_1", {
      loadCharacter: async () =>
        makeCharacter({ twinId: "twin_a", persona: { personality: "Analyst" } }),
      loadTwinProfile,
    })
    expect(out).toBe("Analyst; Replies tersely.")
    expect(loadTwinProfile).toHaveBeenCalledWith("twin_a")
  })

  it("does not read the twin profile when the character has no twinId", async () => {
    const loadTwinProfile = jest.fn(async () => ({ voiceSummary: "unused" }))
    await resolveCharacterPersona("char_1", {
      loadCharacter: async () => makeCharacter({ persona: { personality: "Analyst" } }),
      loadTwinProfile,
    })
    expect(loadTwinProfile).not.toHaveBeenCalled()
  })

  it("returns null when the character is missing", async () => {
    const out = await resolveCharacterPersona("nope", {
      loadCharacter: async () => undefined,
    })
    expect(out).toBeNull()
  })

  it("returns null when the character has no usable persona", async () => {
    const out = await resolveCharacterPersona("char_1", {
      loadCharacter: async () => makeCharacter(),
      loadTwinProfile: async () => undefined,
    })
    expect(out).toBeNull()
  })

  it("falls back to persona-only when the twin profile is missing", async () => {
    const out = await resolveCharacterPersona("char_1", {
      loadCharacter: async () => makeCharacter({ twinId: "twin_a", persona: { tone: "playful" } }),
      loadTwinProfile: async () => undefined,
    })
    expect(out).toBe("tone: playful")
  })
})
