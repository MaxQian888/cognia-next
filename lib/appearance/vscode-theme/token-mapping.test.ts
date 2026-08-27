import { BASE_THEME_COLOR_KEYS, THEME_TOKEN_CATALOG } from "../theme-token-catalog"
import { DEFAULT_FALLBACKS, THEME_COLOR_KEYS, VSCODE_COLOR_MAP } from "./token-mapping"

/**
 * Number of cognia ThemeColors slots — kept in lockstep with the CSS variables
 * declared in `app/globals.css`. 27 of them are required (the shadcn surface
 * set); the other 29 — status, charts, workflow, effort, brand — are optional
 * and filled by `normalizeThemeColors` when a theme leaves them out.
 */
const EXPECTED_THEME_KEY_COUNT = 56

describe("VSCODE_COLOR_MAP", () => {
  it("is a projection of the catalog's vscode lists", () => {
    const fromCatalog = THEME_TOKEN_CATALOG.filter((d) => d.vscode).map((d) => d.key)
    expect(Object.keys(VSCODE_COLOR_MAP).sort()).toEqual([...fromCatalog].sort())
  })

  it("covers every required cognia ThemeColors key", () => {
    for (const key of BASE_THEME_COLOR_KEYS) {
      expect(VSCODE_COLOR_MAP[key]).toBeDefined()
      expect(VSCODE_COLOR_MAP[key]!.length).toBeGreaterThan(0)
    }
  })

  /**
   * Deliberately partial. A workflow node color or the brand triple has no
   * VSCode counterpart, and deriving one from `tokenColors` is an explicit
   * ADR-0007 non-goal — an unmapped token keeps the cognia default instead.
   */
  it("leaves the tokens VSCode has no counterpart for unmapped", () => {
    const unmapped = THEME_TOKEN_CATALOG.filter((d) => !d.vscode).map((d) => d.key)
    expect(unmapped).toEqual([
      "brandAction",
      "brandApproval",
      "brandWash",
      "successForeground",
      "warningForeground",
      "infoForeground",
      "workflowTrigger",
      "workflowAction",
      "workflowAi",
      "workflowFlow",
      "workflowData",
      "workflowIo",
      "workflowAnnotation",
      "workflowStatusIdle",
      "workflowStatusRunning",
      "workflowStatusSucceeded",
      "workflowStatusFailed",
      "workflowStatusSkipped",
      "workflowStatusWaiting",
      "effortUltra",
      "effortUltraMuted",
    ])
  })

  it("has no duplicate VSCode keys within a single mapping list", () => {
    for (const list of Object.values(VSCODE_COLOR_MAP)) {
      expect(new Set(list).size).toBe(list!.length)
    }
  })

  it("uses non-empty VSCode key paths", () => {
    for (const list of Object.values(VSCODE_COLOR_MAP)) {
      for (const candidate of list!) {
        expect(candidate.length).toBeGreaterThan(0)
      }
    }
  })
})

describe("DEFAULT_FALLBACKS", () => {
  /**
   * Scoped to the required set on purpose: this palette is the VSCode parser's
   * last resort for the shadcn surface tokens, not a second answer to "what
   * colour is `--chart-1`". That answer lives in the catalog.
   */
  it("supplies a value for every required key in light and dark", () => {
    for (const key of BASE_THEME_COLOR_KEYS) {
      expect(DEFAULT_FALLBACKS.light[key]).toMatch(/^#[0-9a-f]{6}$/i)
      expect(DEFAULT_FALLBACKS.dark[key]).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it("light and dark differ in background", () => {
    expect(DEFAULT_FALLBACKS.light.background).not.toBe(DEFAULT_FALLBACKS.dark.background)
  })
})

describe("THEME_COLOR_KEYS", () => {
  it("re-exports the catalog's ordering unchanged", () => {
    expect([...THEME_COLOR_KEYS]).toEqual(THEME_TOKEN_CATALOG.map((d) => d.key))
  })

  it("has the full cognia surface set", () => {
    expect(THEME_COLOR_KEYS.length).toBe(EXPECTED_THEME_KEY_COUNT)
  })
})
