import { buildPersonaSection, selectBaseSystemPrompt } from "./base-selection"

describe("selectBaseSystemPrompt", () => {
  it("selects one base by nullish precedence", () => {
    expect(
      selectBaseSystemPrompt({
        sessionPrompt: "s",
        memberOverride: "m",
        characterPrompt: "c",
        appDefault: "d",
      })
    ).toEqual({ text: "s", source: "session" })
    expect(
      selectBaseSystemPrompt({ memberOverride: "m", characterPrompt: "c", appDefault: "d" })
    ).toEqual({ text: "m", source: "team-member" })
    expect(selectBaseSystemPrompt({ characterPrompt: "c", appDefault: "d" })).toEqual({
      text: "c",
      source: "character",
    })
    expect(selectBaseSystemPrompt({ appDefault: "d" })).toEqual({
      text: "d",
      source: "app-default",
    })
    expect(selectBaseSystemPrompt({})).toEqual({ text: undefined, source: "none" })
  })

  it("treats an explicit empty string as a choice that stops the chain", () => {
    expect(selectBaseSystemPrompt({ sessionPrompt: "", characterPrompt: "c" })).toEqual({
      text: "",
      source: "session",
    })
  })
})

describe("buildPersonaSection", () => {
  it("projects tone and personality in that order", () => {
    expect(buildPersonaSection({ tone: " warm ", personality: "A teacher." })).toBe(
      "## Persona\n\nTone: warm\n\nA teacher."
    )
    expect(buildPersonaSection({ personality: "A teacher." })).toBe("## Persona\n\nA teacher.")
  })

  it("is empty when the persona says nothing", () => {
    expect(buildPersonaSection(undefined)).toBe("")
    expect(buildPersonaSection({ tone: "  ", personality: "" })).toBe("")
  })
})
