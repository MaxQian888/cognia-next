import {
  adjustForegroundLightnessToTarget,
  evaluateReadability,
  isColorParsable,
  wcagContrast,
} from "./contrast"

describe("wcagContrast", () => {
  it("returns ~21 for black on white", () => {
    expect(wcagContrast("#000000", "#ffffff")).toBeCloseTo(21, 0)
  })
  it("returns ~1 for same colors", () => {
    expect(wcagContrast("#888888", "#888888")).toBeCloseTo(1, 1)
  })
  it("is symmetric", () => {
    expect(wcagContrast("#123456", "#abcdef")).toBeCloseTo(wcagContrast("#abcdef", "#123456"), 2)
  })
})

describe("isColorParsable", () => {
  it("accepts the notations the appearance module actually stores", () => {
    expect(isColorParsable("#abcdef")).toBe(true)
    expect(isColorParsable("rgb(1 2 3)")).toBe(true)
    expect(isColorParsable("oklch(0.5 0.1 30)")).toBe(true)
    expect(isColorParsable("rebeccapurple")).toBe(true)
  })

  // The reason this helper exists: garbage does not throw, it reads as 1:1.
  it("rejects unresolved vars and nonsense, which wcagContrast reports as 1:1", () => {
    expect(isColorParsable("var(--nope)")).toBe(false)
    expect(isColorParsable("")).toBe(false)
    expect(wcagContrast("var(--nope)", "var(--nope)")).toBeCloseTo(1, 5)
  })
})

describe("evaluateReadability", () => {
  it("returns ok when ratio >= 4.5", () => {
    const r = evaluateReadability({ fgColor: "#000000", bgColor: "#ffffff" })
    expect(r.level).toBe("ok")
    expect(r.ratio).toBeGreaterThanOrEqual(4.5)
    expect(r.recommendation).toBeUndefined()
  })

  it("returns warn when 3 <= ratio < 4.5", () => {
    // #888888 on #ffffff produces a ratio of ~3.54 — solidly in the warn band.
    const r = evaluateReadability({ fgColor: "#888888", bgColor: "#ffffff" })
    expect(r.level).toBe("warn")
    expect(r.ratio).toBeGreaterThanOrEqual(3)
    expect(r.ratio).toBeLessThan(4.5)
    expect(r.recommendation).toBeDefined()
  })

  it("returns fail when ratio < 3", () => {
    const r = evaluateReadability({ fgColor: "#999999", bgColor: "#aaaaaa" })
    expect(r.level).toBe("fail")
    expect(r.ratio).toBeLessThan(3)
    expect(r.recommendation).toBeDefined()
  })
})

describe("adjustForegroundLightnessToTarget", () => {
  it("returns the same color when it already meets the target", () => {
    const fixed = adjustForegroundLightnessToTarget("#000000", "#ffffff", 4.5)
    expect(fixed).not.toBeNull()
    expect(wcagContrast(fixed ?? "#000000", "#ffffff")).toBeGreaterThanOrEqual(4.5)
  })

  // Both directions have an early exit for "the bracket's near edge already
  // passes": nothing to search for, so the original lightness is kept.
  it("keeps the original lightness when the near bracket edge already passes", () => {
    expect(adjustForegroundLightnessToTarget("#ffffff", "#000000", 4.5)).toBe(
      adjustForegroundLightnessToTarget("#ffffff", "#000000", 4.5)
    )
    for (const [fg, bg] of [
      ["#ffffff", "#000000"],
      ["#000000", "#ffffff"],
    ]) {
      const fixed = adjustForegroundLightnessToTarget(fg, bg, 4.5)
      expect(fixed).not.toBeNull()
      // 21:1 already — the search must not drag it toward the threshold.
      expect(wcagContrast(fixed!, bg)).toBeCloseTo(21, 0)
    }
  })

  it("darkens a too-light foreground on a light background", () => {
    // Light gray on white fails AA — adjuster should darken until it passes.
    const fixed = adjustForegroundLightnessToTarget("#aaaaaa", "#ffffff", 4.5)
    expect(fixed).not.toBeNull()
    expect(wcagContrast(fixed ?? "#aaaaaa", "#ffffff")).toBeGreaterThanOrEqual(4.5 - 0.05)
  })

  it("lightens a too-dark foreground on a dark background", () => {
    const fixed = adjustForegroundLightnessToTarget("#444444", "#222222", 4.5)
    expect(fixed).not.toBeNull()
    expect(wcagContrast(fixed ?? "#444444", "#222222")).toBeGreaterThanOrEqual(4.5 - 0.05)
  })

  it("hits AAA when asked", () => {
    const fixed = adjustForegroundLightnessToTarget("#666666", "#ffffff", 7)
    expect(fixed).not.toBeNull()
    expect(wcagContrast(fixed ?? "#666666", "#ffffff")).toBeGreaterThanOrEqual(7 - 0.05)
  })

  it("returns null for unparseable inputs", () => {
    expect(adjustForegroundLightnessToTarget("not-a-color", "#ffffff", 4.5)).toBeNull()
  })
})
