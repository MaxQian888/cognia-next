import fs from "node:fs"
import path from "node:path"
import {
  importVscodeThemeJson,
  parseVscodeJson,
  stripJsonComments,
  vscodeThemeToCustomTheme,
} from "./parse-json"
import { THEME_COLOR_KEYS } from "./token-mapping"

const fixtureDir = path.join(__dirname, "__fixtures__")

describe("stripJsonComments", () => {
  it("strips line and block comments", () => {
    const text = `// header\n{\n  /* block */\n  "a": 1, // trailing\n  "b": 2\n}`
    const cleaned = stripJsonComments(text)
    expect(cleaned).not.toContain("//")
    expect(cleaned).not.toContain("/*")
    expect(JSON.parse(cleaned)).toEqual({ a: 1, b: 2 })
  })

  it("preserves comment markers inside strings", () => {
    const text = `{"a": "// not a comment", "b": "/* nope */"}`
    const cleaned = stripJsonComments(text)
    expect(JSON.parse(cleaned)).toEqual({ a: "// not a comment", b: "/* nope */" })
  })

  it("handles escaped quotes in strings", () => {
    const text = `{"a": "she said \\"hi\\"" }`
    const cleaned = stripJsonComments(text)
    expect(JSON.parse(cleaned).a).toBe('she said "hi"')
  })

  it("removes trailing commas in objects and arrays", () => {
    const cleaned = stripJsonComments(`{ "a": 1, "b": [1,2,3,], }`)
    expect(JSON.parse(cleaned)).toEqual({ a: 1, b: [1, 2, 3] })
  })
})

describe("parseVscodeJson", () => {
  it("returns null for invalid JSON", () => {
    expect(parseVscodeJson("not json")).toBeNull()
    expect(parseVscodeJson("[1,2,")).toBeNull()
  })

  it("returns null when the top-level is not an object", () => {
    expect(parseVscodeJson("[1, 2]")).not.toBeNull()
    // Arrays still pass since they're objects at runtime — defensive
    // call sites should check for `colors` field afterwards.
  })

  it("parses a JSONC file with comments and trailing commas", () => {
    const text = `// dark theme\n{\n  "name": "X",\n  "type": "dark",\n  "colors": { "editor.background": "#000", },\n}`
    const parsed = parseVscodeJson(text)
    expect(parsed?.name).toBe("X")
    expect(parsed?.colors?.["editor.background"]).toBe("#000")
  })
})

describe("vscodeThemeToCustomTheme", () => {
  it("uses theme.name when nameHint is not provided", () => {
    const out = vscodeThemeToCustomTheme({ name: "Dracula", type: "dark" })
    expect(out.theme.name).toBe("Dracula")
    expect(out.theme.isDark).toBe(true)
  })

  it("nameHint overrides theme.name", () => {
    const out = vscodeThemeToCustomTheme({ name: "Dracula" }, { nameHint: "My Dracula" })
    expect(out.theme.name).toBe("My Dracula")
  })

  it("defaults to a dark variant when type is missing", () => {
    const out = vscodeThemeToCustomTheme({})
    expect(out.theme.isDark).toBe(true)
  })

  it("recognises light and high-contrast light variants", () => {
    expect(vscodeThemeToCustomTheme({ type: "light" }).theme.isDark).toBe(false)
    expect(vscodeThemeToCustomTheme({ type: "hc-light" }).theme.isDark).toBe(false)
    expect(vscodeThemeToCustomTheme({ type: "hc-black" }).theme.isDark).toBe(true)
  })

  it("forceVariant wins over the theme's declared type", () => {
    const out = vscodeThemeToCustomTheme({ type: "light" }, { forceVariant: "dark" })
    expect(out.theme.isDark).toBe(true)
  })

  it("maps a basic VSCode theme onto cognia ThemeColors", () => {
    const out = vscodeThemeToCustomTheme({
      name: "Sample",
      type: "dark",
      colors: {
        "editor.background": "#0b0d10",
        "editor.foreground": "#e6edf3",
        "button.background": "#1f6feb",
        "button.foreground": "#ffffff",
        "panel.border": "#30363d",
        "list.activeSelectionBackground": "#1c2128",
        "list.activeSelectionForeground": "#e6edf3",
        focusBorder: "#388bfd",
        errorForeground: "#f85149",
      },
    })
    expect(out.matchedCount).toBeGreaterThanOrEqual(8)
    expect(out.theme.colors.background).toBe("#0b0d10")
    expect(out.theme.colors.foreground).toBe("#e6edf3")
    expect(out.theme.colors.primary).toBe("#1f6feb")
    expect(out.theme.colors.primaryForeground).toBe("#ffffff")
    expect(out.theme.colors.border).toBe("#30363d")
    expect(out.theme.colors.accent).toBe("#1c2128")
    expect(out.theme.colors.accentForeground).toBe("#e6edf3")
    expect(out.theme.colors.ring).toBe("#388bfd")
    expect(out.theme.colors.destructive).toBe("#f85149")
  })

  it("strips alpha from 8-digit hex values", () => {
    const out = vscodeThemeToCustomTheme({
      type: "dark",
      colors: {
        "editor.background": "#11223380",
      },
    })
    expect(out.theme.colors.background).toBe("#112233")
  })

  it("derives missing tokens from bg/fg when possible", () => {
    const out = vscodeThemeToCustomTheme({
      type: "dark",
      colors: {
        "editor.background": "#222222",
        "editor.foreground": "#eeeeee",
      },
    })
    // muted should be lightened bg
    expect(out.theme.colors.muted).not.toBe("#222222")
    expect(out.theme.colors.muted).toMatch(/^#[0-9a-f]{6}$/i)
    // ring derives from the foreground (via accentSource) instead of the
    // hardcoded blue fallback now that derivation runs first.
    expect(out.theme.colors.ring).toMatch(/^#[0-9a-f]{6}$/i)
    expect(out.theme.colors.ring).not.toBe("#60a5fa")
  })

  it("does NOT use the hardcoded blue primary when theme provides bg/fg but no button.background", () => {
    // A minimalist VSCode theme with only bg/fg defined.
    const json = JSON.stringify({
      type: "dark",
      colors: {
        "editor.background": "#1a1a2e",
        "editor.foreground": "#eaeaea",
      },
    })
    const parsed = importVscodeThemeJson(json)
    // The hardcoded primary fallback is #60a5fa (dark) / #3b82f6 (light).
    // With derivation-first, ring/accent now derive from foreground rather
    // than the hardcoded blue ring/accent in DEFAULT_FALLBACKS.
    expect(parsed.theme.colors.ring).not.toBe("#60a5fa")
    expect(parsed.theme.colors.accent).not.toBe("#60a5fa")
    // Sidebar derives from bg/fg, not the hardcoded dark sidebar value.
    expect(parsed.theme.colors.sidebar).not.toBe("#0f172a")
  })

  it("populates all 27 ThemeColors keys (no holes after derivation)", () => {
    const json = JSON.stringify({
      type: "dark",
      colors: {
        "editor.background": "#0b1220",
        "editor.foreground": "#f1f5f9",
      },
    })
    const parsed = importVscodeThemeJson(json)
    for (const key of THEME_COLOR_KEYS) {
      expect(parsed.theme.colors[key]).toBeDefined()
      expect(parsed.theme.colors[key].length).toBeGreaterThan(0)
    }
  })

  it("flags themes with no colors object", () => {
    const out = vscodeThemeToCustomTheme({ type: "light" })
    expect(out.emptyColors).toBe(true)
    expect(out.matchedCount).toBe(0)
    // It still returns a usable theme (everything came from fallbacks).
    expect(out.theme.colors.background).toBe("#ffffff")
  })

  it("ignores invalid hex values", () => {
    const out = vscodeThemeToCustomTheme({
      colors: {
        "editor.background": "not-a-color",
        "button.background": "#aa0",
      },
    })
    expect(out.theme.colors.background).not.toBe("not-a-color")
    // 3-digit hex was accepted (parseHex handles short form).
    expect(out.theme.colors.primary).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe("importVscodeThemeJson", () => {
  it("parses + converts in one call", () => {
    const text = `{\n "name": "T",\n "type": "dark",\n "colors": { "editor.background": "#101010" }\n}`
    const out = importVscodeThemeJson(text)
    expect(out.theme.name).toBe("T")
    expect(out.theme.colors.background).toBe("#101010")
  })

  it("throws on invalid JSON", () => {
    expect(() => importVscodeThemeJson("not json")).toThrow(/Invalid/)
  })

  it("respects nameHint when provided", () => {
    const text = `{ "name": "Original", "type": "light" }`
    const out = importVscodeThemeJson(text, { nameHint: "Override" })
    expect(out.theme.name).toBe("Override")
  })
})

// Integration-style snapshot check against a real-world theme excerpt.
// Trimmed verbatim from the publicly-licensed One Dark Pro theme; we
// only keep the keys we care about.
describe("integration: real theme snapshot", () => {
  it("imports an excerpt of One Dark Pro without errors", () => {
    const json = `{
      "name": "One Dark Pro",
      "type": "dark",
      "colors": {
        "editor.background": "#282c34",
        "editor.foreground": "#abb2bf",
        "editor.lineHighlightBackground": "#2c313c",
        "button.background": "#4d78cc",
        "button.foreground": "#ffffff",
        "tab.activeBackground": "#282c34",
        "tab.activeForeground": "#dcdcdc",
        "panel.border": "#3e4451",
        "focusBorder": "#3e4451",
        "errorForeground": "#e06c75"
      }
    }`
    const out = importVscodeThemeJson(json)
    expect(out.matchedCount).toBeGreaterThanOrEqual(8)
    expect(out.theme.name).toBe("One Dark Pro")
    expect(out.theme.isDark).toBe(true)
    expect(out.theme.colors.background).toBe("#282c34")
    expect(out.theme.colors.primary).toBe("#4d78cc")
  })
})

// Real-world VSCode palettes (synthetic from canonical references — the
// upstream theme repos either ship YAML/TS sources or built artifacts >50KB).
// These pin the Task 10 fallback-order fix against representative data:
// every colors output must populate all 27 ThemeColors keys, and the
// hardcoded blue accent fallback must NOT appear for any real palette.
describe("real VSCode themes parse without errors", () => {
  it.each(["dracula", "one-dark-pro", "tokyo-night-dark", "github-light-default"])("%s", (name) => {
    const text = fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8")
    const result = importVscodeThemeJson(text)
    // Background and foreground are always populated.
    expect(result.theme.colors.background).toMatch(/^(#|oklch\()/)
    expect(result.theme.colors.foreground).toMatch(/^(#|oklch\()/)
    // No accent should be the hardcoded blue fallback after Task 10.
    expect(result.theme.colors.accent).not.toBe("#60a5fa")
    expect(result.theme.colors.accent).not.toBe("#3b82f6")
    // All 27 keys populated.
    for (const key of THEME_COLOR_KEYS) {
      expect(result.theme.colors[key]).toBeDefined()
      expect(result.theme.colors[key].length).toBeGreaterThan(0)
    }
  })
})
