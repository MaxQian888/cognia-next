/**
 * @jest-environment jsdom
 */
import {
  loadGenerationPreferences,
  normalizeGenerationPreferences,
  saveGenerationPreferences,
} from "./generation-preferences"

const STORAGE_KEY = "a2ui-generation-preferences"

describe("normalizeGenerationPreferences", () => {
  it("keeps only the known string fields", () => {
    expect(
      normalizeGenerationPreferences({
        characterId: "char_1",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        somethingElse: "dropped",
      })
    ).toEqual({ characterId: "char_1", model: "claude-sonnet-4-5", provider: "anthropic" })
  })

  it("treats blank and non-string values as absent", () => {
    expect(
      normalizeGenerationPreferences({ characterId: "  ", model: 42, provider: null })
    ).toEqual({})
  })

  it("returns an empty preference for a non-object", () => {
    for (const input of [null, undefined, "x", 7, ["a"]]) {
      expect(normalizeGenerationPreferences(input)).toEqual({})
    }
  })
})

describe("generation preference storage", () => {
  beforeEach(() => window.localStorage.clear())

  it("reads as unset when nothing was stored", () => {
    expect(loadGenerationPreferences()).toEqual({})
  })

  it("round-trips a saved preference", () => {
    saveGenerationPreferences({ characterId: "char_1", model: "gpt-5", provider: "openai" })
    expect(loadGenerationPreferences()).toEqual({
      characterId: "char_1",
      model: "gpt-5",
      provider: "openai",
    })
  })

  it("removes the row entirely once every field is cleared", () => {
    saveGenerationPreferences({ characterId: "char_1" })
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull()

    saveGenerationPreferences({ characterId: undefined })
    // Not an empty object left behind: an absent key and a cleared preference
    // must be the same state, because both mean "use the app defaults".
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(loadGenerationPreferences()).toEqual({})
  })

  it("survives a corrupt blob instead of throwing on page load", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json")
    expect(loadGenerationPreferences()).toEqual({})
  })

  it("drops unknown fields that were persisted by an older build", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ model: "m", legacyEffort: "high" }))
    expect(loadGenerationPreferences()).toEqual({ model: "m" })
  })

  it("does not throw when storage rejects the write", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    expect(() => saveGenerationPreferences({ model: "m" })).not.toThrow()
    setItem.mockRestore()
  })
})
