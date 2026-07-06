/**
 * Tests for Canvas Settings Store
 */

import { act, renderHook } from "@testing-library/react"
import { useCanvasSettingsStore } from "./canvas-settings-store"
import { DEFAULT_CANVAS_SETTINGS } from "@/types/canvas/settings"

describe("useCanvasSettingsStore", () => {
  beforeEach(() => {
    const { result } = renderHook(() => useCanvasSettingsStore())
    act(() => {
      result.current.resetSettings()
    })
  })

  describe("initial state", () => {
    it("should have default settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())
      expect(result.current.settings).toEqual(DEFAULT_CANVAS_SETTINGS)
    })

    it("should have correct default editor settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())
      const { editor } = result.current.settings

      expect(editor.fontSize).toBe(14)
      expect(editor.tabSize).toBe(2)
      expect(editor.wordWrap).toBe(false)
      expect(editor.minimap).toBe(true)
      expect(editor.lineNumbers).toBe("on")
      expect(editor.cursorBlinking).toBe("blink")
      expect(editor.cursorStyle).toBe("line")
      expect(editor.bracketPairColorization).toBe(true)
    })

    it("should have correct default AI settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())
      const { ai } = result.current.settings

      expect(ai.autoSuggestions).toBe(true)
      expect(ai.suggestionDelay).toBe(1000)
      expect(ai.maxSuggestions).toBe(5)
      expect(ai.streamingResponses).toBe(true)
      expect(ai.enableInlineCompletion).toBe(true)
    })

    it("should have correct default version settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())
      const { version } = result.current.settings

      expect(version.autoSaveInterval).toBe(30)
      expect(version.maxVersions).toBe(50)
      expect(version.diffViewMode).toBe("inline")
    })
  })

  describe("updateEditorSettings", () => {
    it("should update a single editor setting", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({ fontSize: 18 })
      })

      expect(result.current.settings.editor.fontSize).toBe(18)
      // Other settings unchanged
      expect(result.current.settings.editor.tabSize).toBe(2)
      expect(result.current.settings.editor.minimap).toBe(true)
    })

    it("should update multiple editor settings at once", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({
          fontSize: 20,
          wordWrap: true,
          minimap: false,
          lineNumbers: "relative",
        })
      })

      expect(result.current.settings.editor.fontSize).toBe(20)
      expect(result.current.settings.editor.wordWrap).toBe(true)
      expect(result.current.settings.editor.minimap).toBe(false)
      expect(result.current.settings.editor.lineNumbers).toBe("relative")
    })

    it("should not affect non-editor settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({ fontSize: 24 })
      })

      expect(result.current.settings.ai).toEqual(DEFAULT_CANVAS_SETTINGS.ai)
      expect(result.current.settings.version).toEqual(DEFAULT_CANVAS_SETTINGS.version)
    })
  })

  describe("updateAISettings", () => {
    it("should update AI settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateAISettings({
          autoSuggestions: false,
          suggestionDelay: 2000,
        })
      })

      expect(result.current.settings.ai.autoSuggestions).toBe(false)
      expect(result.current.settings.ai.suggestionDelay).toBe(2000)
      // Other AI settings unchanged
      expect(result.current.settings.ai.maxSuggestions).toBe(5)
    })
  })

  describe("updateVersionSettings", () => {
    it("should update version settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateVersionSettings({
          autoSaveInterval: 60,
          maxVersions: 100,
          diffViewMode: "side-by-side",
        })
      })

      expect(result.current.settings.version.autoSaveInterval).toBe(60)
      expect(result.current.settings.version.maxVersions).toBe(100)
      expect(result.current.settings.version.diffViewMode).toBe("side-by-side")
    })
  })

  describe("updateSettings", () => {
    it("should merge valid settings and return empty errors", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      let errors: string[] = []
      act(() => {
        errors = result.current.updateSettings({
          editor: { ...DEFAULT_CANVAS_SETTINGS.editor, fontSize: 16 },
          theme: "monokai",
        })
      })

      expect(errors).toEqual([])
      expect(result.current.settings.editor.fontSize).toBe(16)
      expect(result.current.settings.theme).toBe("monokai")
    })

    it("should reject invalid font size and return errors", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      let errors: string[] = []
      act(() => {
        errors = result.current.updateSettings({
          editor: { ...DEFAULT_CANVAS_SETTINGS.editor, fontSize: 3 },
        })
      })

      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain("Font size")
      // Settings should NOT be updated
      expect(result.current.settings.editor.fontSize).toBe(14)
    })

    it("should reject invalid tab size", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      let errors: string[] = []
      act(() => {
        errors = result.current.updateSettings({
          editor: { ...DEFAULT_CANVAS_SETTINGS.editor, tabSize: 10 },
        })
      })

      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain("Tab size")
    })

    it("should reject invalid AI suggestion delay", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      let errors: string[] = []
      act(() => {
        errors = result.current.updateSettings({
          ai: { ...DEFAULT_CANVAS_SETTINGS.ai, suggestionDelay: 50 },
        })
      })

      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain("Suggestion delay")
    })

    it("should reject invalid version settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      let errors: string[] = []
      act(() => {
        errors = result.current.updateSettings({
          version: { ...DEFAULT_CANVAS_SETTINGS.version, autoSaveInterval: 5 },
        })
      })

      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain("Auto-save interval")
    })
  })

  describe("resetSettings", () => {
    it("should reset all settings to defaults", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({ fontSize: 24, wordWrap: true })
        result.current.updateAISettings({ autoSuggestions: false })
      })

      expect(result.current.settings.editor.fontSize).toBe(24)
      expect(result.current.settings.ai.autoSuggestions).toBe(false)

      act(() => {
        result.current.resetSettings()
      })

      expect(result.current.settings).toEqual(DEFAULT_CANVAS_SETTINGS)
    })
  })

  describe("resetSection", () => {
    it("should reset only the editor section", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({ fontSize: 24 })
        result.current.updateAISettings({ autoSuggestions: false })
      })

      act(() => {
        result.current.resetSection("editor")
      })

      // Editor reset
      expect(result.current.settings.editor).toEqual(DEFAULT_CANVAS_SETTINGS.editor)
      // AI still modified
      expect(result.current.settings.ai.autoSuggestions).toBe(false)
    })

    it("should reset only the AI section", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({ fontSize: 24 })
        result.current.updateAISettings({ autoSuggestions: false })
      })

      act(() => {
        result.current.resetSection("ai")
      })

      // AI reset
      expect(result.current.settings.ai).toEqual(DEFAULT_CANVAS_SETTINGS.ai)
      // Editor still modified
      expect(result.current.settings.editor.fontSize).toBe(24)
    })
  })

  describe("getEditorOptions", () => {
    it("should return Monaco-compatible editor options", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())
      const options = result.current.getEditorOptions()

      expect(options.fontSize).toBe(14)
      expect(options.tabSize).toBe(2)
      expect(options.wordWrap).toBe("off")
      expect(options.minimap).toEqual({ enabled: true, scale: 1 })
      expect(options.lineNumbers).toBe("on")
      expect(options.autoClosingBrackets).toBe("always")
      expect(options.autoClosingQuotes).toBe("always")
      expect(options.bracketPairColorization).toEqual({ enabled: true })
      expect(options.stickyScroll).toEqual({ enabled: true, maxLineCount: 5 })
      expect(options.inlineSuggest).toEqual({ enabled: true })
    })

    it("should reflect updated settings", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({
          wordWrap: true,
          minimap: false,
          autoClosingBrackets: false,
        })
      })

      const options = result.current.getEditorOptions()
      expect(options.wordWrap).toBe("on")
      expect(options.minimap).toEqual({ enabled: false, scale: 1 })
      expect(options.autoClosingBrackets).toBe("never")
    })

    it("maps the new typography/rendering options", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({
          fontLigatures: false,
          letterSpacing: 1.5,
          minimapScale: 2,
          renderLineHighlight: "all",
          stickyScroll: false,
          stickyScrollMaxLines: 8,
          folding: false,
          showFoldingControls: "always",
          inlineSuggest: false,
          cursorSmoothCaretAnimation: "on",
          padding: { top: 12, bottom: 20 },
        })
      })

      const options = result.current.getEditorOptions()
      expect(options.fontLigatures).toBe(false)
      expect(options.letterSpacing).toBe(1.5)
      expect(options.minimap).toEqual({ enabled: true, scale: 2 })
      expect(options.renderLineHighlight).toBe("all")
      expect(options.stickyScroll).toEqual({ enabled: false, maxLineCount: 8 })
      expect(options.folding).toBe(false)
      expect(options.showFoldingControls).toBe("always")
      expect(options.inlineSuggest).toEqual({ enabled: false })
      expect(options.cursorSmoothCaretAnimation).toBe("on")
      expect(options.padding).toEqual({ top: 12, bottom: 20 })
    })

    it("wires accessibility: screen-reader forces accessibilitySupport on", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      expect(result.current.getEditorOptions().accessibilitySupport).toBe("auto")

      act(() => {
        result.current.updateSettings({
          accessibility: {
            ...DEFAULT_CANVAS_SETTINGS.accessibility,
            screenReaderOptimized: true,
          },
        })
      })

      expect(result.current.getEditorOptions().accessibilitySupport).toBe("on")
    })

    it("wires accessibility: reduced-motion overrides animation options", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())

      act(() => {
        result.current.updateEditorSettings({
          smoothScrolling: true,
          cursorSmoothCaretAnimation: "on",
          cursorBlinking: "smooth",
        })
        result.current.updateSettings({
          accessibility: {
            ...DEFAULT_CANVAS_SETTINGS.accessibility,
            reducedMotion: true,
          },
        })
      })

      const options = result.current.getEditorOptions()
      expect(options.smoothScrolling).toBe(false)
      expect(options.cursorSmoothCaretAnimation).toBe("off")
      expect(options.cursorBlinking).toBe("solid")
    })
  })

  describe("validation of new editor options", () => {
    it("rejects out-of-range letter spacing, minimap scale, sticky lines, and padding", () => {
      const { result } = renderHook(() => useCanvasSettingsStore())
      const base = DEFAULT_CANVAS_SETTINGS.editor

      const cases: Array<[Partial<typeof base>, string]> = [
        [{ letterSpacing: 20 }, "Letter spacing"],
        [{ minimapScale: 5 }, "Minimap scale"],
        [{ stickyScrollMaxLines: 50 }, "Sticky scroll max lines"],
        [{ padding: { top: 100, bottom: 0 } }, "Editor padding"],
      ]

      for (const [patch, expected] of cases) {
        let errors: string[] = []
        act(() => {
          errors = result.current.updateSettings({ editor: { ...base, ...patch } })
        })
        expect(errors.some((e) => e.includes(expected))).toBe(true)
      }
    })
  })
})
