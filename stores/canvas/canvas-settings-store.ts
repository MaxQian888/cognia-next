/**
 * Canvas Settings Store - Persistent editor configuration
 * Uses types from @/types/canvas/settings
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
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
        const { editor } = get().settings
        return {
          fontSize: editor.fontSize,
          fontFamily: editor.fontFamily,
          lineHeight: editor.lineHeight,
          tabSize: editor.tabSize,
          insertSpaces: editor.insertSpaces,
          wordWrap: editor.wordWrap ? "on" : "off",
          minimap: { enabled: editor.minimap, scale: 1 },
          lineNumbers: editor.lineNumbers,
          renderWhitespace: editor.renderWhitespace,
          scrollBeyondLastLine: editor.scrollBeyondLastLine,
          autoClosingBrackets: editor.autoClosingBrackets ? "always" : "never",
          autoClosingQuotes: editor.autoClosingQuotes ? "always" : "never",
          formatOnPaste: editor.formatOnPaste,
          formatOnType: editor.formatOnType,
          cursorBlinking: editor.cursorBlinking,
          cursorStyle: editor.cursorStyle,
          smoothScrolling: editor.smoothScrolling,
          mouseWheelZoom: editor.mouseWheelZoom,
          bracketPairColorization: { enabled: editor.bracketPairColorization },
          guides: editor.guides,
          stickyScroll: { enabled: true, maxLineCount: 5 },
          inlineSuggest: { enabled: true },
        }
      },
    }),
    {
      name: "cognia-canvas-settings",
      partialize: (state) => ({
        settings: state.settings,
      }),
    }
  )
)

export default useCanvasSettingsStore
