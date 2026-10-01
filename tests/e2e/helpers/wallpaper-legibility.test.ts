// The pure half of the wallpaper legibility instrument: the WCAG arithmetic the
// specs judge rendered pixels with, and the pass/fail threshold. The browser
// half (collecting text, decoding screenshots, finding islands) runs only
// inside Playwright and is exercised by the specs themselves.

jest.mock("@/tests/e2e/fixtures/test", () => ({ expect: jest.fn() }))
jest.mock("./db-reset", () => ({ ensureCogniaAccount: jest.fn() }))

import {
  THEMES,
  WALLPAPERS,
  contrast,
  describeSample,
  legibilityFailures,
  luminance,
  type MeasuredSample,
} from "./wallpaper-legibility"

function sample(over: Partial<MeasuredSample>): MeasuredSample {
  return {
    text: "Label",
    role: "foreground",
    box: { x: 0, y: 0, width: 40, height: 12 },
    rgb: [0, 0, 0],
    native: 21,
    worst: 21,
    ...over,
  }
}

describe("wallpaper legibility instrument", () => {
  it("computes WCAG relative luminance and contrast", () => {
    expect(luminance(0, 0, 0)).toBe(0)
    expect(luminance(255, 255, 255)).toBeCloseTo(1, 6)
    expect(contrast(1, 0)).toBeCloseTo(21, 6)
    // Order does not matter.
    expect(contrast(0.2, 0.8)).toBeCloseTo(contrast(0.8, 0.2), 9)
    // #767676 on white is the canonical 4.54:1.
    expect(contrast(luminance(255, 255, 255), luminance(0x76, 0x76, 0x76))).toBeCloseTo(4.54, 2)
  })

  it("holds foreground to 4.5:1 and muted to 3:1, with 10% slack", () => {
    expect(legibilityFailures([sample({ worst: 4.5 * 0.9 })])).toEqual([])
    expect(legibilityFailures([sample({ worst: 4.5 * 0.9 - 0.01 })])).toHaveLength(1)
    expect(legibilityFailures([sample({ role: "muted", worst: 3 * 0.9 })])).toEqual([])
    expect(legibilityFailures([sample({ role: "muted", worst: 2.6 })])).toHaveLength(1)
  })

  it("caps a target at 95% of what the bare theme achieves", () => {
    // A low-contrast theme cannot be held to a ratio it never had: muted at a
    // native 2.5:1 is judged against 2.375, not 3.
    const lowContrast = sample({ role: "muted", native: 2.5, worst: 2.2 })
    expect(legibilityFailures([lowContrast])).toEqual([])
    expect(legibilityFailures([{ ...lowContrast, worst: 2.1 }])).toHaveLength(1)
  })

  it("names a failing sample by role, text and ratio", () => {
    expect(describeSample(sample({ role: "muted", text: "Hint", worst: 1.8234 }))).toBe(
      'muted "Hint" 1.82:1'
    )
  })

  it("covers both directions of contrast and every theme case", () => {
    // The busy wallpaper carries a near-black and a near-white stripe, so it is
    // the worst case for dark and light ink at once.
    expect(WALLPAPERS.busy.source).toEqual(
      expect.objectContaining({ css: expect.stringMatching(/#050505.*#fafafa/) })
    )
    expect(THEMES.map((t) => t.name)).toEqual([
      "light",
      "dark",
      "high-contrast dark",
      "ocean preset",
    ])
  })
})
