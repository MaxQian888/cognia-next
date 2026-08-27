/** @jest-environment jsdom */
import { applyAppearance, isAppliedAppearance } from "./apply-appearance"

const APPEARANCE = {
  mode: "dark" as const,
  cssVars: { "--background": "oklch(0.145 0 0)", "--chart-1": "oklch(0.6 0.2 40)" },
  radiusBaseRem: 0.5,
  pillRadiusPx: 0,
  density: "compact" as const,
}

describe("applyAppearance", () => {
  it("writes the Host's variables verbatim", () => {
    const root = document.createElement("html")
    applyAppearance(root, APPEARANCE)
    expect(root.style.getPropertyValue("--background")).toBe("oklch(0.145 0 0)")
    // A name a camel→kebab guess would have got wrong; the Host sends the
    // catalog's name and this writes exactly that.
    expect(root.style.getPropertyValue("--chart-1")).toBe("oklch(0.6 0.2 40)")
  })

  it("carries the shape tokens as well as the colours", () => {
    const root = document.createElement("html")
    applyAppearance(root, APPEARANCE)
    expect(root.style.getPropertyValue("--radius")).toBe("0.5rem")
    // A Sharp-pack Host squares the pills; the panel has to follow or one
    // capsule is left behind in an otherwise squared-off UI.
    expect(root.style.getPropertyValue("--pill-radius")).toBe("0px")
    expect(root.dataset.density).toBe("compact")
  })

  it("un-darks when the Host switches to light", () => {
    // The one combination that produces unreadable text is a stale `.dark`
    // over a light palette, so the class is toggled in both directions.
    const root = document.createElement("html")
    applyAppearance(root, APPEARANCE)
    expect(root.classList.contains("dark")).toBe(true)
    applyAppearance(root, { ...APPEARANCE, mode: "light" })
    expect(root.classList.contains("dark")).toBe(false)
    expect(root.classList.contains("light")).toBe(true)
  })

  it("skips empty values rather than blanking a token", () => {
    const root = document.createElement("html")
    root.style.setProperty("--background", "red")
    applyAppearance(root, { ...APPEARANCE, cssVars: { "--background": "  " } })
    expect(root.style.getPropertyValue("--background")).toBe("red")
  })

  it("reports what it wrote", () => {
    const root = document.createElement("html")
    const written = applyAppearance(root, APPEARANCE)
    expect(written).toContain("--background")
    expect(written).toContain("--radius")
  })
})

describe("isAppliedAppearance", () => {
  it("accepts a well-formed appearance", () => {
    expect(isAppliedAppearance(APPEARANCE)).toBe(true)
  })

  it("rejects anything a different build might have stored", () => {
    // `chrome.storage.local` survives extension updates, so a value written by
    // an older build arrives here shaped differently. Applying half of one
    // leaves a palette that is neither the Host's nor the fallback.
    for (const bad of [
      null,
      undefined,
      "dark",
      { ...APPEARANCE, mode: "system" },
      { ...APPEARANCE, cssVars: null },
      { ...APPEARANCE, radiusBaseRem: "0.5rem" },
      { ...APPEARANCE, density: "cosy" },
      {},
    ]) {
      expect(isAppliedAppearance(bad)).toBe(false)
    }
  })
})
