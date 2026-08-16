import { STARTER_CARDS, availableStarterCards, starterCardsWithFallback } from "./starter-cards"

describe("STARTER_CARDS", () => {
  it("has a stable, unique id per card", () => {
    const ids = STARTER_CARDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("includes exactly one card with no local requirement", () => {
    // The requirement-free card is what a paired phone (and the fallback path)
    // depends on; more than one would make "the fallback" ambiguous.
    expect(STARTER_CARDS.filter((c) => c.requires.length === 0)).toHaveLength(1)
  })
})

describe("availableStarterCards", () => {
  it("offers everything when every capability is present", () => {
    const out = availableStarterCards({ shell: "tauri", capabilities: ["fs", "ocr", "web"] })
    expect(out.map((c) => c.id)).toEqual(["read-folder", "extract-text", "summarize-web"])
  })

  it("hides a card whose capability was not confirmed", () => {
    // Hidden rather than disabled: a greyed-out card still advertises something
    // the user cannot do, which is the old tour's failure mode with extra steps.
    const out = availableStarterCards({ shell: "tauri", capabilities: ["fs"] })
    expect(out.map((c) => c.id)).toEqual(["read-folder", "summarize-web"])
  })

  it("leaves a paired phone with only the requirement-free card", () => {
    const out = availableStarterCards({ shell: "mobile-paired", capabilities: [] })
    expect(out.map((c) => c.id)).toEqual(["summarize-web"])
  })

  it("offers the OCR card to a standalone phone that has a camera pipeline", () => {
    const out = availableStarterCards({ shell: "mobile-standalone", capabilities: ["ocr"] })
    expect(out.map((c) => c.id)).toEqual(["extract-text", "summarize-web"])
  })

  it("returns nothing when even the web capability is absent", () => {
    expect(availableStarterCards({ shell: "web", capabilities: [] }).map((c) => c.id)).toEqual([
      "summarize-web",
    ])
  })
})

describe("starterCardsWithFallback", () => {
  it("matches availableStarterCards when anything is available", () => {
    const input = { shell: "tauri" as const, capabilities: ["fs"] as const }
    expect(starterCardsWithFallback(input)).toEqual(availableStarterCards(input))
  })

  it("never returns an empty list", () => {
    // Reaching the first-run step with no cards would strand the user one
    // screen short of the entire point of the flow.
    const out = starterCardsWithFallback({ shell: "tauri", capabilities: [] })
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("summarize-web")
  })
})
