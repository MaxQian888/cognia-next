import { THEMES, THEME_LIST } from "./syntax-themes"
import type { ThemeId, ThemeTokens } from "./syntax-themes"

describe("THEMES", () => {
  it("contains every documented theme id", () => {
    const expected: ThemeId[] = [
      "light",
      "dark",
      "sepia",
      "github",
      "dracula",
      "nord",
      "solarized",
      "monokai",
    ]
    for (const id of expected) {
      expect(THEMES[id]).toBeDefined()
    }
  })

  it("each theme has every token slot", () => {
    const slots: (keyof ThemeTokens)[] = [
      "bg",
      "surface",
      "text",
      "muted",
      "border",
      "accent",
      "userBg",
      "assistantBg",
      "codeBg",
      "codeText",
      "detailBg",
    ]
    for (const id of Object.keys(THEMES) as ThemeId[]) {
      const tokens = THEMES[id]
      for (const slot of slots) {
        expect(typeof tokens[slot]).toBe("string")
        expect(tokens[slot]).toMatch(/^#?[0-9a-fA-F]{3,8}$/)
      }
    }
  })
})

describe("THEME_LIST", () => {
  it("matches the keys of THEMES", () => {
    const ids = THEME_LIST.map((t) => t.id)
    expect(new Set(ids)).toEqual(new Set(Object.keys(THEMES)))
  })

  it("each entry has a label", () => {
    for (const e of THEME_LIST) {
      expect(typeof e.label).toBe("string")
      expect(e.label.length).toBeGreaterThan(0)
    }
  })
})
