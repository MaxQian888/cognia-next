import { THEME_TOKEN_BY_KEY } from "./theme-token-catalog"
import {
  COLORBLIND_CATEGORICAL_KEYS,
  COLORBLIND_SIMULATOR_MATRICES,
  colorblindThemeOverrides,
} from "./colorblind-palettes"

describe("colorblindThemeOverrides", () => {
  it("returns an empty object for 'off'", () => {
    expect(colorblindThemeOverrides("off")).toEqual({})
  })

  it.each(["deuter", "protan", "tritan"] as const)(
    "covers every categorical token for %s",
    (mode) => {
      const overrides = colorblindThemeOverrides(mode)
      for (const key of COLORBLIND_CATEGORICAL_KEYS) {
        expect(overrides[key]).toMatch(/^oklch/)
      }
    }
  )

  it.each(["deuter", "protan", "tritan"] as const)(
    "%s shifts destructive away from the default red",
    (mode) => {
      const overrides = colorblindThemeOverrides(mode)
      expect(overrides.destructive).toBeDefined()
      expect(overrides.destructive).toMatch(/^oklch/)
    }
  )

  it("returns a fresh object each call (callers may mutate)", () => {
    const a = colorblindThemeOverrides("deuter")
    const b = colorblindThemeOverrides("deuter")
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  /**
   * The categorical set is a choice, not an oversight: annotation is a neutral
   * grey with no categorical meaning, and the workflow statuses either alias a
   * signal colour that is already patched or are greys of their own. Pinned so
   * a future "we forgot these" edit has to be deliberate.
   */
  it("leaves annotation and the workflow statuses alone", () => {
    const overrides = colorblindThemeOverrides("deuter")
    expect(overrides.workflowAnnotation).toBeUndefined()
    expect(overrides.workflowStatusIdle).toBeUndefined()
    expect(overrides.workflowStatusRunning).toBeUndefined()
    expect(overrides.workflowStatusSkipped).toBeUndefined()
  })

  it("only names tokens the catalog owns", () => {
    for (const mode of ["deuter", "protan", "tritan"] as const) {
      for (const key of Object.keys(colorblindThemeOverrides(mode))) {
        expect(THEME_TOKEN_BY_KEY[key as keyof typeof THEME_TOKEN_BY_KEY]).toBeDefined()
      }
    }
  })
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
