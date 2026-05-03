import { DEFAULT_FALLBACKS, THEME_COLOR_KEYS, VSCODE_COLOR_MAP } from "./token-mapping"

describe("VSCODE_COLOR_MAP", () => {
  it("covers every cognia ThemeColors key", () => {
    for (const key of THEME_COLOR_KEYS) {
      expect(VSCODE_COLOR_MAP[key]).toBeDefined()
      expect(VSCODE_COLOR_MAP[key].length).toBeGreaterThan(0)
    }
  })

  it("has no duplicate VSCode keys within a single mapping list", () => {
    for (const key of THEME_COLOR_KEYS) {
      const list = VSCODE_COLOR_MAP[key]
      expect(new Set(list).size).toBe(list.length)
    }
  })

  it("uses dotted VSCode key paths", () => {
    for (const key of THEME_COLOR_KEYS) {
      for (const candidate of VSCODE_COLOR_MAP[key]) {
        expect(candidate.length).toBeGreaterThan(0)
      }
    }
  })
})

describe("DEFAULT_FALLBACKS", () => {
  it("supplies a value for every key in light and dark", () => {
    for (const key of THEME_COLOR_KEYS) {
      expect(DEFAULT_FALLBACKS.light[key]).toMatch(/^#[0-9a-f]{6}$/i)
      expect(DEFAULT_FALLBACKS.dark[key]).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it("light and dark differ in background", () => {
    expect(DEFAULT_FALLBACKS.light.background).not.toBe(DEFAULT_FALLBACKS.dark.background)
  })
})

describe("THEME_COLOR_KEYS", () => {
  it("matches VSCODE_COLOR_MAP key set", () => {
    const fromMap = Object.keys(VSCODE_COLOR_MAP).sort()
    const fromList = [...THEME_COLOR_KEYS].sort()
    expect(fromList).toEqual(fromMap)
  })
})
