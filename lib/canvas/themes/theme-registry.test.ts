/**
 * Comprehensive Tests for Theme Registry
 */

import {
  ThemeRegistry,
  themeRegistry,
  BUILTIN_THEMES,
  type EditorTheme,
  type ThemeColors,
} from "./theme-registry"

describe("ThemeRegistry", () => {
  let registry: ThemeRegistry

  beforeEach(() => {
    registry = new ThemeRegistry()
  })

  describe("constructor", () => {
    it("should initialize with builtin themes", () => {
      const themes = registry.getAllThemes()
      expect(themes.length).toBeGreaterThan(0)
      expect(themes.length).toBeGreaterThanOrEqual(BUILTIN_THEMES.length)
    })

    it("should have vs-dark as default active theme", () => {
      expect(registry.getActiveThemeId()).toBe("vs-dark")
    })
  })

  describe("registerTheme", () => {
    it("should register a new theme", () => {
      const customTheme: EditorTheme = {
        id: "custom-theme",
        name: "Custom Theme",
        dark: true,
        base: "vs-dark",
        colors: {
          background: "#1a1a1a",
          foreground: "#ffffff",
          cursor: "#ffffff",
          selection: "#444444",
          selectionHighlight: "#555555",
          lineHighlight: "#2a2a2a",
          lineNumber: "#888888",
          lineNumberActive: "#ffffff",
          gutterBackground: "#1a1a1a",
          gutterForeground: "#888888",
          scrollbarSlider: "#444444",
          scrollbarSliderHover: "#555555",
          scrollbarSliderActive: "#666666",
          editorIndentGuide: "#333333",
          editorActiveIndentGuide: "#555555",
          matchingBracket: "#666666",
          findMatch: "#444444",
          findMatchHighlight: "#555555",
          minimap: "#333333",
          minimapSlider: "#444444",
        },
        tokenColors: [{ scope: "comment", settings: { foreground: "#888888" } }],
      }

      registry.registerTheme(customTheme)

      const retrieved = registry.getTheme("custom-theme")
      expect(retrieved).toBeDefined()
      expect(retrieved?.name).toBe("Custom Theme")
    })

    it("should overwrite existing theme with same ID", () => {
      const theme1: EditorTheme = {
        id: "test-theme",
        name: "Test Theme 1",
        dark: true,
        base: "vs-dark",
        colors: {} as ThemeColors,
        tokenColors: [],
      }

      const theme2: EditorTheme = {
        id: "test-theme",
        name: "Test Theme 2",
        dark: true,
        base: "vs-dark",
        colors: {} as ThemeColors,
        tokenColors: [],
      }

      registry.registerTheme(theme1)
      registry.registerTheme(theme2)

      const retrieved = registry.getTheme("test-theme")
      expect(retrieved?.name).toBe("Test Theme 2")
    })
  })

  describe("unregisterTheme", () => {
    it("should unregister a custom theme", () => {
      const customTheme: EditorTheme = {
        id: "to-remove",
        name: "To Remove",
        dark: true,
        base: "vs-dark",
        colors: {} as ThemeColors,
        tokenColors: [],
      }

      registry.registerTheme(customTheme)
      expect(registry.getTheme("to-remove")).toBeDefined()

      const result = registry.unregisterTheme("to-remove")
      expect(result).toBe(true)
      expect(registry.getTheme("to-remove")).toBeUndefined()
    })

    it("should not unregister builtin themes", () => {
      const result = registry.unregisterTheme("vs-dark")
      expect(result).toBe(false)
      expect(registry.getTheme("vs-dark")).toBeDefined()
    })

    it("should return false for non-existent theme", () => {
      const result = registry.unregisterTheme("non-existent")
      expect(result).toBe(false)
    })
  })

  describe("getTheme", () => {
    it("should return theme by ID", () => {
      const theme = registry.getTheme("vs-dark")
      expect(theme).toBeDefined()
      expect(theme?.id).toBe("vs-dark")
    })

    it("should return undefined for non-existent theme", () => {
      const theme = registry.getTheme("non-existent")
      expect(theme).toBeUndefined()
    })
  })

  describe("getAllThemes", () => {
    it("should return all registered themes", () => {
      const themes = registry.getAllThemes()
      expect(Array.isArray(themes)).toBe(true)
      expect(themes.length).toBeGreaterThan(0)
    })

    it("should include builtin themes", () => {
      const themes = registry.getAllThemes()
      expect(themes.some((t) => t.id === "vs-dark")).toBe(true)
      expect(themes.some((t) => t.id === "vs")).toBe(true)
    })
  })

  describe("getDarkThemes", () => {
    it("should return only dark themes", () => {
      const darkThemes = registry.getDarkThemes()
      expect(darkThemes.length).toBeGreaterThan(0)
      expect(darkThemes.every((t) => t.dark === true)).toBe(true)
    })
  })

  describe("getLightThemes", () => {
    it("should return only light themes", () => {
      const lightThemes = registry.getLightThemes()
      expect(lightThemes.length).toBeGreaterThan(0)
      expect(lightThemes.every((t) => t.dark === false)).toBe(true)
    })
  })

  describe("setActiveTheme", () => {
    it("should set active theme", () => {
      const result = registry.setActiveTheme("monokai")
      expect(result).toBe(true)
      expect(registry.getActiveThemeId()).toBe("monokai")
    })

    it("should return false for non-existent theme", () => {
      const result = registry.setActiveTheme("non-existent")
      expect(result).toBe(false)
    })

    it("should not change active theme if not found", () => {
      const originalId = registry.getActiveThemeId()
      registry.setActiveTheme("non-existent")
      expect(registry.getActiveThemeId()).toBe(originalId)
    })
  })

  describe("getActiveTheme", () => {
    it("should return the active theme", () => {
      const theme = registry.getActiveTheme()
      expect(theme).toBeDefined()
      expect(theme?.id).toBe(registry.getActiveThemeId())
    })
  })

  describe("getActiveThemeId", () => {
    it("should return the active theme ID", () => {
      const id = registry.getActiveThemeId()
      expect(typeof id).toBe("string")
      expect(id.length).toBeGreaterThan(0)
    })
  })

  describe("toMonacoTheme", () => {
    it("should convert theme to Monaco format", () => {
      const theme = registry.getTheme("vs-dark")!
      const monacoTheme = registry.toMonacoTheme(theme)

      expect(monacoTheme).toBeDefined()
      expect(monacoTheme.base).toBe("vs-dark")
      expect(monacoTheme.inherit).toBe(true)
      expect(Array.isArray(monacoTheme.rules)).toBe(true)
      expect(typeof monacoTheme.colors).toBe("object")
    })

    it("should include editor colors", () => {
      const theme = registry.getTheme("vs-dark")!
      const monacoTheme = registry.toMonacoTheme(theme)

      expect(monacoTheme.colors["editor.background"]).toBeDefined()
      expect(monacoTheme.colors["editor.foreground"]).toBeDefined()
      expect(monacoTheme.colors["editorCursor.foreground"]).toBeDefined()
    })

    it("should convert token colors to rules", () => {
      const theme = registry.getTheme("vs-dark")!
      const monacoTheme = registry.toMonacoTheme(theme)

      expect(monacoTheme.rules.length).toBeGreaterThan(0)
      expect(monacoTheme.rules[0].token).toBeDefined()
    })

    it("should strip # from color values in rules", () => {
      const theme = registry.getTheme("vs-dark")!
      const monacoTheme = registry.toMonacoTheme(theme)

      const ruleWithForeground = monacoTheme.rules.find((r) => r.foreground)
      if (ruleWithForeground?.foreground) {
        expect(ruleWithForeground.foreground.startsWith("#")).toBe(false)
      }
    })
  })

  describe("exportTheme", () => {
    it("should export theme as JSON string", () => {
      const json = registry.exportTheme("vs-dark")

      expect(json).toBeTruthy()
      expect(typeof json).toBe("string")

      const parsed = JSON.parse(json!)
      expect(parsed.id).toBe("vs-dark")
      expect(parsed.name).toBeDefined()
      expect(parsed.colors).toBeDefined()
      expect(parsed.tokenColors).toBeDefined()
    })

    it("should return null for non-existent theme", () => {
      const json = registry.exportTheme("non-existent")
      expect(json).toBeNull()
    })
  })

  describe("importTheme", () => {
    it("should import theme from JSON", () => {
      const themeData: EditorTheme = {
        id: "imported-theme",
        name: "Imported Theme",
        dark: true,
        base: "vs-dark",
        colors: {
          background: "#000000",
          foreground: "#ffffff",
          cursor: "#ffffff",
          selection: "#333333",
          selectionHighlight: "#444444",
          lineHighlight: "#111111",
          lineNumber: "#666666",
          lineNumberActive: "#ffffff",
          gutterBackground: "#000000",
          gutterForeground: "#666666",
          scrollbarSlider: "#333333",
          scrollbarSliderHover: "#444444",
          scrollbarSliderActive: "#555555",
          editorIndentGuide: "#222222",
          editorActiveIndentGuide: "#444444",
          matchingBracket: "#555555",
          findMatch: "#333333",
          findMatchHighlight: "#444444",
          minimap: "#222222",
          minimapSlider: "#333333",
        },
        tokenColors: [],
      }

      const imported = registry.importTheme(JSON.stringify(themeData))

      expect(imported).toBeDefined()
      expect(imported?.id).toBe("imported-theme")
      expect(registry.getTheme("imported-theme")).toBeDefined()
    })

    it("should return null for invalid JSON", () => {
      const result = registry.importTheme("invalid json")
      expect(result).toBeNull()
    })

    it("should return null for incomplete theme data", () => {
      const result = registry.importTheme(JSON.stringify({ id: "incomplete" }))
      expect(result).toBeNull()
    })
  })

  describe("BUILTIN_THEMES", () => {
    it("should have vs-dark theme", () => {
      const vsDark = BUILTIN_THEMES.find((t) => t.id === "vs-dark")
      expect(vsDark).toBeDefined()
      expect(vsDark?.dark).toBe(true)
    })

    it("should have vs (light) theme", () => {
      const vsLight = BUILTIN_THEMES.find((t) => t.id === "vs")
      expect(vsLight).toBeDefined()
      expect(vsLight?.dark).toBe(false)
    })

    it("should have monokai theme", () => {
      const monokai = BUILTIN_THEMES.find((t) => t.id === "monokai")
      expect(monokai).toBeDefined()
    })

    it("should have github-dark theme", () => {
      const githubDark = BUILTIN_THEMES.find((t) => t.id === "github-dark")
      expect(githubDark).toBeDefined()
    })

    it("should have one-dark-pro theme", () => {
      const oneDarkPro = BUILTIN_THEMES.find((t) => t.id === "one-dark-pro")
      expect(oneDarkPro).toBeDefined()
    })

    it("all themes should have required properties", () => {
      for (const theme of BUILTIN_THEMES) {
        expect(theme.id).toBeTruthy()
        expect(theme.name).toBeTruthy()
        expect(typeof theme.dark).toBe("boolean")
        expect(theme.base).toBeTruthy()
        expect(theme.colors).toBeDefined()
        expect(theme.tokenColors).toBeDefined()
      }
    })
  })

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(themeRegistry).toBeInstanceOf(ThemeRegistry)
    })

    it("should have all methods available", () => {
      expect(typeof themeRegistry.registerTheme).toBe("function")
      expect(typeof themeRegistry.unregisterTheme).toBe("function")
      expect(typeof themeRegistry.getTheme).toBe("function")
      expect(typeof themeRegistry.getAllThemes).toBe("function")
      expect(typeof themeRegistry.getDarkThemes).toBe("function")
      expect(typeof themeRegistry.getLightThemes).toBe("function")
      expect(typeof themeRegistry.setActiveTheme).toBe("function")
      expect(typeof themeRegistry.getActiveTheme).toBe("function")
      expect(typeof themeRegistry.getActiveThemeId).toBe("function")
      expect(typeof themeRegistry.toMonacoTheme).toBe("function")
      expect(typeof themeRegistry.exportTheme).toBe("function")
      expect(typeof themeRegistry.importTheme).toBe("function")
    })
  })
})
