/**
 * @jest-environment jsdom
 */

import { isFontFamilyAvailable, primaryFamilyOf, unquoteFamily } from "./font-availability"

/**
 * Install a fake 2D context whose `measureText` width is driven by the font
 * string. `widths` maps a substring of the font string to the width it should
 * report; the first match wins, otherwise `fallback` is used.
 */
function stubCanvas(widths: Array<[string, number]>, fallback: number): jest.Mock {
  const measureText = jest.fn(() => ({ width: 0 }))
  const ctx = {
    font: "",
    measureText: () => {
      const hit = widths.find(([needle]) => ctx.font.includes(needle))
      return { width: hit ? hit[1] : fallback }
    },
  }
  const getContext = jest.fn(() => ctx)
  jest
    .spyOn(document, "createElement")
    .mockImplementation(() => ({ getContext }) as unknown as HTMLElement)
  return measureText
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe("unquoteFamily", () => {
  it("strips wrapping quotes and whitespace", () => {
    expect(unquoteFamily('  "Fira Code" ')).toBe("Fira Code")
    expect(unquoteFamily("'Menlo'")).toBe("Menlo")
    expect(unquoteFamily("Menlo")).toBe("Menlo")
  })
})

describe("primaryFamilyOf", () => {
  it("takes the first family of a stack", () => {
    expect(primaryFamilyOf('"MesloLGS NF", "JetBrains Mono", monospace')).toBe("MesloLGS NF")
  })

  it("returns an empty string for a blank stack", () => {
    expect(primaryFamilyOf("   ")).toBe("")
    expect(primaryFamilyOf("")).toBe("")
  })
})

describe("isFontFamilyAvailable", () => {
  it("returns null for a blank family", () => {
    expect(isFontFamilyAvailable("  ")).toBeNull()
  })

  it("treats CSS generics as always available without probing", () => {
    const createElement = jest.spyOn(document, "createElement")
    expect(isFontFamilyAvailable("monospace")).toBe(true)
    expect(isFontFamilyAvailable("ui-monospace")).toBe(true)
    expect(isFontFamilyAvailable("SANS-SERIF")).toBe(true)
    expect(createElement).not.toHaveBeenCalled()
  })

  it("reports available when the family measures differently from the control", () => {
    // The candidate string contains the family name; the bare control does not.
    stubCanvas([["Fira Code", 210]], 200)
    expect(isFontFamilyAvailable("Fira Code")).toBe(true)
  })

  it("reports unavailable when every control measures identically", () => {
    stubCanvas([], 200)
    expect(isFontFamilyAvailable("No Such Font")).toBe(false)
  })

  it("returns null when text measurement is unimplemented (zero widths)", () => {
    stubCanvas([], 0)
    expect(isFontFamilyAvailable("No Such Font")).toBeNull()
  })

  it("returns null when no 2D context is obtainable", () => {
    jest
      .spyOn(document, "createElement")
      .mockImplementation(() => ({ getContext: () => null }) as unknown as HTMLElement)
    expect(isFontFamilyAvailable("Fira Code")).toBeNull()
  })

  it("returns null instead of throwing when the canvas API blows up", () => {
    jest.spyOn(document, "createElement").mockImplementation(() => {
      throw new Error("no canvas")
    })
    expect(isFontFamilyAvailable("Fira Code")).toBeNull()
  })

  it("accepts a quoted family name", () => {
    stubCanvas([["Fira Code", 210]], 200)
    expect(isFontFamilyAvailable('"Fira Code"')).toBe(true)
  })
})
