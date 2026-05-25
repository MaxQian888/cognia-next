import type { Character } from "@/lib/claude/types"

import {
  buildPersona,
  buildVoiceProfile,
  characterToPackDef,
  classifyCharacterSource,
  filterCharacters,
  parseLines,
} from "./editor-projection"

describe("parseLines", () => {
  it("splits on newlines, trims, and drops blanks", () => {
    expect(parseLines("  one \n\n two  \n   \nthree")).toEqual(["one", "two", "three"])
  })

  it("keeps commas intact (exemplar prompts are full sentences)", () => {
    expect(parseLines("Review my PR, then summarize")).toEqual(["Review my PR, then summarize"])
  })

  it("returns an empty array for blank input", () => {
    expect(parseLines("   \n  ")).toEqual([])
  })
})

describe("buildPersona", () => {
  const empty = { tone: "", personality: "", openingMessage: "", exemplarPromptsText: "" }

  it("returns undefined when every field is blank", () => {
    expect(buildPersona(empty)).toBeUndefined()
    expect(buildPersona({ ...empty, tone: "   " })).toBeUndefined()
  })

  it("includes only the non-blank fields", () => {
    expect(buildPersona({ ...empty, tone: "warm" })).toEqual({ tone: "warm" })
    expect(
      buildPersona({
        tone: "warm",
        personality: "Patient teacher",
        openingMessage: "Hello!",
        exemplarPromptsText: "Explain X\nDraft Y",
      })
    ).toEqual({
      tone: "warm",
      personality: "Patient teacher",
      openingMessage: "Hello!",
      exemplarPrompts: ["Explain X", "Draft Y"],
    })
  })

  it("trims values", () => {
    expect(buildPersona({ ...empty, openingMessage: "  hi  " })).toEqual({ openingMessage: "hi" })
  })
})

describe("buildVoiceProfile", () => {
  const base = { provider: "openai" as const, voiceId: "alloy", rate: 1, pitch: 1, volume: 1 }

  it("returns undefined when provider is none", () => {
    expect(buildVoiceProfile({ ...base, provider: "none" })).toBeUndefined()
  })

  it("returns undefined when voiceId is blank", () => {
    expect(buildVoiceProfile({ ...base, voiceId: "   " })).toBeUndefined()
  })

  it("projects provider, trimmed voiceId, and the rate/pitch/volume knobs", () => {
    expect(
      buildVoiceProfile({
        provider: "elevenlabs",
        voiceId: " rachel ",
        rate: 1.2,
        pitch: 0.9,
        volume: 0.8,
      })
    ).toEqual({ provider: "elevenlabs", voiceId: "rachel", rate: 1.2, pitch: 0.9, volume: 0.8 })
  })
})

describe("classifyCharacterSource / filterCharacters", () => {
  const builtin = { id: "char_builtin_x", name: "Coder", isBuiltIn: true } as Character
  const plugin = {
    id: "cognia-pack:plug:pack:alice",
    name: "Alice",
    sourcePluginId: "plug",
  } as Character
  const cloned = { id: "char_1", name: "My Clone", sourcePluginId: "plug" } as Character
  const user = { id: "char_2", name: "Helper", description: "writes docs" } as Character
  const all = [builtin, plugin, cloned, user]

  it("classifies built-in / plugin (overlay or cloned) / user", () => {
    expect(classifyCharacterSource(builtin)).toBe("builtin")
    expect(classifyCharacterSource(plugin)).toBe("plugin")
    expect(classifyCharacterSource(cloned)).toBe("plugin")
    expect(classifyCharacterSource(user)).toBe("user")
  })

  it("filters by source bucket", () => {
    expect(filterCharacters(all, "", "user")).toEqual([user])
    expect(filterCharacters(all, "", "builtin")).toEqual([builtin])
    expect(filterCharacters(all, "", "plugin")).toEqual([plugin, cloned])
    expect(filterCharacters(all, "", "all")).toHaveLength(4)
  })

  it("filters by name and description, case-insensitively", () => {
    expect(filterCharacters(all, "ALICE", "all")).toEqual([plugin])
    expect(filterCharacters(all, "docs", "all")).toEqual([user])
    expect(filterCharacters(all, "nomatch", "all")).toEqual([])
  })

  it("combines source + query", () => {
    expect(filterCharacters(all, "clone", "plugin")).toEqual([cloned])
    expect(filterCharacters(all, "clone", "user")).toEqual([])
  })
})

describe("characterToPackDef", () => {
  const base: Character = {
    id: "char_123",
    name: "Tutor",
    avatarColor: "#abc",
    systemPrompt: "You are a tutor.",
    createdAt: 5,
    updatedAt: 9,
  } as Character

  it("keeps the required pack fields and drops host-only / undefined fields", () => {
    const def = characterToPackDef(base)
    expect(def).toEqual({
      localId: "char_123",
      name: "Tutor",
      avatarColor: "#abc",
      systemPrompt: "You are a tutor.",
    })
    // Lifecycle / host fields never leak into the portable def.
    expect("createdAt" in def).toBe(false)
    expect("id" in def).toBe(false)
  })

  it("carries the v2 fields through when present", () => {
    const def = characterToPackDef({
      ...base,
      avatarEmoji: "🐙",
      model: "claude-sonnet-4-6",
      persona: { tone: "warm" },
      voiceProfile: { provider: "openai", voiceId: "alloy" },
      avatarImage: { webDataUrl: "data:image/png;base64,AAA" },
      availableOnPlatforms: ["tauri"],
    } as Character)
    expect(def.avatarEmoji).toBe("🐙")
    expect(def.model).toBe("claude-sonnet-4-6")
    expect(def.persona).toEqual({ tone: "warm" })
    expect(def.voiceProfile).toEqual({ provider: "openai", voiceId: "alloy" })
    expect(def.avatarImage).toEqual({ webDataUrl: "data:image/png;base64,AAA" })
    expect(def.availableOnPlatforms).toEqual(["tauri"])
  })
})
