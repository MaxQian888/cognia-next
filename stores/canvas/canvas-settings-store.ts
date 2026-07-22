/**
 * Canvas Settings Store - Persistent editor configuration
 * Uses types from @/types/canvas/settings
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import {
  type CanvasSettings,
  type CanvasEditorSettings,
  type CanvasAISettings,
  type CanvasVersionSettings,
  DEFAULT_CANVAS_SETTINGS,
  mergeSettings,
  validateSettings,
} from "@/types/canvas/settings"

interface CanvasSettingsState {
  settings: CanvasSettings

  updateEditorSettings: (updates: Partial<CanvasEditorSettings>) => void
  updateAISettings: (updates: Partial<CanvasAISettings>) => void
  updateVersionSettings: (updates: Partial<CanvasVersionSettings>) => void
  updateSettings: (updates: Partial<CanvasSettings>) => string[]
  resetSettings: () => void
  resetSection: (section: keyof CanvasSettings) => void
  getEditorOptions: () => Record<string, unknown>
}

export const useCanvasSettingsStore = create<CanvasSettingsState>()(
  persist(
    (set, get) => ({
      settings: { ...DEFAULT_CANVAS_SETTINGS },

      updateEditorSettings: (updates) => {
        set((state) => ({
          settings: {
            ...state.settings,
            editor: { ...state.settings.editor, ...updates },
          },
        }))
      },

      updateAISettings: (updates) => {
        set((state) => ({
          settings: {
            ...state.settings,
            ai: { ...state.settings.ai, ...updates },
          },
        }))
      },

      updateVersionSettings: (updates) => {
        set((state) => ({
          settings: {
            ...state.settings,
            version: { ...state.settings.version, ...updates },
          },
        }))
      },

      updateSettings: (updates) => {
        const errors = validateSettings(updates)
        if (errors.length === 0) {
          const current = get().settings
          set({ settings: mergeSettings(current, updates) })
        }
        return errors
      },

      resetSettings: () => {
        set({ settings: { ...DEFAULT_CANVAS_SETTINGS } })
      },

      resetSection: (section) => {
        set((state) => ({
          settings: {
            ...state.settings,
            [section]: DEFAULT_CANVAS_SETTINGS[section],
          },
        }))
      },

      getEditorOptions: () => {
        const { editor, accessibility } = get().settings
        const options: Record<string, unknown> = {
          fontSize: editor.fontSize,
          fontFamily: editor.fontFamily,
          fontLigatures: editor.fontLigatures,
          letterSpacing: editor.letterSpacing,
          lineHeight: editor.lineHeight,
          tabSize: editor.tabSize,
          insertSpaces: editor.insertSpaces,
          wordWrap: editor.wordWrap ? "on" : "off",
          minimap: { enabled: editor.minimap, scale: editor.minimapScale },
          lineNumbers: editor.lineNumbers,
          renderWhitespace: editor.renderWhitespace,
          renderLineHighlight: editor.renderLineHighlight,
          scrollBeyondLastLine: editor.scrollBeyondLastLine,
          autoClosingBrackets: editor.autoClosingBrackets ? "always" : "never",
          autoClosingQuotes: editor.autoClosingQuotes ? "always" : "never",
          formatOnPaste: editor.formatOnPaste,
          formatOnType: editor.formatOnType,
          cursorBlinking: editor.cursorBlinking,
          cursorStyle: editor.cursorStyle,
          cursorSmoothCaretAnimation: editor.cursorSmoothCaretAnimation,
          smoothScrolling: editor.smoothScrolling,
          mouseWheelZoom: editor.mouseWheelZoom,
          bracketPairColorization: { enabled: editor.bracketPairColorization },
          padding: { top: editor.padding.top, bottom: editor.padding.bottom },
          guides: editor.guides,
          folding: editor.folding,
          showFoldingControls: editor.showFoldingControls,
          stickyScroll: {
            enabled: editor.stickyScroll,
            maxLineCount: editor.stickyScrollMaxLines,
          },
          inlineSuggest: { enabled: editor.inlineSuggest },
          // Screen-reader mode forces Monaco's accessible DOM tree; otherwise
          // let Monaco auto-detect so sighted users keep the fast canvas.
          accessibilitySupport: accessibility.screenReaderOptimized ? "on" : "auto",
        }
        // Reduced-motion is an accessibility override: it wins over the editor's
        // own animation prefs so a user who asked for calm never gets a moving
        // caret or momentum scroll, whatever the editor tab says.
        if (accessibility.reducedMotion) {
          options.smoothScrolling = false
          options.cursorSmoothCaretAnimation = "off"
          options.cursorBlinking = "solid"
        }
        return options
      },
    }),
    {
      name: "cognia-canvas-settings",
      storage: persistLocalStorage(),
      partialize: (state) => ({
        settings: state.settings,
      }),
    }
  )
)

export default useCanvasSettingsStore
