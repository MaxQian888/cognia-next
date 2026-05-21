import {
  COLORBLIND_EXTRA_VAR_KEYS,
  COLORBLIND_SIMULATOR_MATRICES,
  colorblindCssVars,
  colorblindThemeOverrides,
} from "./colorblind-palettes"

describe("colorblindCssVars", () => {
  it("returns an empty object for 'off'", () => {
    expect(colorblindCssVars("off")).toEqual({})
  })

  it.each(["deuter", "protan", "tritan"] as const)("covers every extra var key for %s", (mode) => {
    const map = colorblindCssVars(mode)
    for (const key of COLORBLIND_EXTRA_VAR_KEYS) {
      expect(map[key]).toMatch(/^oklch/)
    }
  })

  it("returns a fresh object each call (callers may mutate)", () => {
    const a = colorblindCssVars("deuter")
    const b = colorblindCssVars("deuter")
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})

describe("colorblindThemeOverrides", () => {
  it("returns an empty object for 'off'", () => {
    expect(colorblindThemeOverrides("off")).toEqual({})
  })

  it.each(["deuter", "protan", "tritan"] as const)(
    "%s shifts destructive away from the default red",
    (mode) => {
      const overrides = colorblindThemeOverrides(mode)
      expect(overrides.destructive).toBeDefined()
      expect(overrides.destructive).toMatch(/^oklch/)
    }
  )
})

describe("COLORBLIND_SIMULATOR_MATRICES", () => {
  it("ships a 20-value matrix for each non-off mode", () => {
    for (const mode of ["deuter", "protan", "tritan"] as const) {
      expect(COLORBLIND_SIMULATOR_MATRICES[mode]).toHaveLength(20)
    }
  })

  it("alpha row is identity (0 0 0 1 0)", () => {
    for (const mode of ["deuter", "protan", "tritan"] as const) {
      const m = COLORBLIND_SIMULATOR_MATRICES[mode]
      expect(m.slice(15)).toEqual([0, 0, 0, 1, 0])
    }
  })
})
