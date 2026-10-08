import { catalogModelCapabilities } from "./external-agent"

describe("catalogModelCapabilities", () => {
  it("projects a Pi/OMP model record", () => {
    expect(
      catalogModelCapabilities({
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
      })
    ).toEqual({ contextWindow: 200_000, reasoning: true, vision: true })
  })

  it("reports a text-only, non-reasoning model as such", () => {
    expect(
      catalogModelCapabilities({ reasoning: false, input: ["text"], contextWindow: 64_000 })
    ).toEqual({ contextWindow: 64_000, reasoning: false, vision: false })
  })

  it("drops malformed fields instead of coercing them", () => {
    expect(
      catalogModelCapabilities({ reasoning: "yes", input: "image", contextWindow: null })
    ).toBeUndefined()
    expect(catalogModelCapabilities({ contextWindow: 0 })).toBeUndefined()
    expect(catalogModelCapabilities({ contextWindow: Number.NaN })).toBeUndefined()
  })

  it("returns undefined for a record that says nothing", () => {
    expect(catalogModelCapabilities({})).toBeUndefined()
  })
})
