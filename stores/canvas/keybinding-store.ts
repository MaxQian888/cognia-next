/**
 * Keybinding Store - Customizable keyboard shortcuts for Canvas
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { loggers } from "@/lib/logger"
import {
  normalizeKeyCombo,
  parseKeyEvent as parseKeyEventShared,
  formatKeybinding as formatKeybindingShared,
} from "@/lib/shortcuts/utils"
import { findConflicts } from "@/lib/shortcuts/conflict"

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  "canvas.save": "Ctrl+S",
  "canvas.saveVersion": "Ctrl+Shift+S",
  "canvas.undo": "Ctrl+Z",
  "canvas.redo": "Ctrl+Y",
  "canvas.find": "Ctrl+F",
  "canvas.replace": "Ctrl+H",
  "canvas.goToLine": "Ctrl+G",
  "canvas.format": "Shift+Alt+F",
  "canvas.toggleWordWrap": "Alt+Z",
  "canvas.toggleMinimap": "Ctrl+Shift+M",
  "canvas.close": "Escape",
  "action.review": "Ctrl+Shift+R",
  "action.fix": "Ctrl+Shift+F",
  "action.improve": "Ctrl+Shift+I",
  "action.explain": "Ctrl+Shift+E",
  "action.simplify": "Ctrl+Shift+L",
  "action.expand": "Ctrl+Shift+X",
  "action.translate": "Ctrl+Shift+T",
  "action.run": "Ctrl+Enter",
  "navigation.nextSuggestion": "Alt+]",
  "navigation.prevSuggestion": "Alt+[",
  "navigation.acceptSuggestion": "Tab",
  "navigation.rejectSuggestion": "Escape",
  "navigation.nextDocument": "Ctrl+Tab",
  "navigation.prevDocument": "Ctrl+Shift+Tab",
  "view.toggleHistory": "Ctrl+Shift+H",
  "view.toggleSuggestions": "Ctrl+.",
  "view.toggleInlineCommand": "Ctrl+K",
  "view.toggleExecution": "Ctrl+`",
  "edit.selectAll": "Ctrl+A",
  "edit.copy": "Ctrl+C",
  "edit.cut": "Ctrl+X",
  "edit.paste": "Ctrl+V",
  "edit.duplicate": "Ctrl+D",
  "edit.comment": "Ctrl+/",
  "fold.foldAll": "Ctrl+K Ctrl+0",
  "fold.unfoldAll": "Ctrl+K Ctrl+J",
  "fold.foldLevel1": "Ctrl+K Ctrl+1",
  "fold.foldLevel2": "Ctrl+K Ctrl+2",
}

interface KeybindingState {
  bindings: Record<string, string>
  defaultBindings: Record<string, string>
  conflicts: Record<string, string[]>

  setKeybinding: (action: string, keyCombo: string) => void
  resetKeybinding: (action: string) => void
  resetAllBindings: () => void
  exportBindings: () => string
  importBindings: (json: string) => boolean
  getKeybinding: (action: string) => string | undefined
  getActionByKeybinding: (keyCombo: string) => string | undefined
  checkConflicts: () => Record<string, string[]>
  isModified: (action: string) => boolean
}

export const useKeybindingStore = create<KeybindingState>()(
  persist(
    (set, get) => ({
      bindings: { ...DEFAULT_KEYBINDINGS },
      defaultBindings: DEFAULT_KEYBINDINGS,
      conflicts: {},

      setKeybinding: (action: string, keyCombo: string) => {
        const normalized = normalizeKeyCombo(keyCombo)
        set((state) => ({
          bindings: { ...state.bindings, [action]: normalized },
        }))
        get().checkConflicts()
      },

      resetKeybinding: (action: string) => {
        set((state) => ({
          bindings: {
            ...state.bindings,
            [action]: state.defaultBindings[action] || "",
          },
        }))
        get().checkConflicts()
      },

      resetAllBindings: () => {
        set((state) => ({
          bindings: { ...state.defaultBindings },
          conflicts: {},
        }))
      },

      exportBindings: () => {
        return JSON.stringify(get().bindings, null, 2)
      },

      importBindings: (json: string) => {
        try {
          const bindings = JSON.parse(json)
          if (typeof bindings !== "object" || bindings === null) {
            return false
          }

          const normalizedBindings: Record<string, string> = {}
          for (const [action, keyCombo] of Object.entries(bindings)) {
            if (typeof keyCombo === "string") {
              normalizedBindings[action] = normalizeKeyCombo(keyCombo)
            }
          }

          set({ bindings: normalizedBindings })
          get().checkConflicts()
          return true
        } catch (err) {
          loggers.canvas.warn("keybinding import failed", {
            error: String(err),
            preview: json.slice(0, 200),
          })
          return false
        }
      },

      getKeybinding: (action: string) => {
        return get().bindings[action]
      },

      getActionByKeybinding: (keyCombo: string) => {
        const normalized = normalizeKeyCombo(keyCombo)
        const bindings = get().bindings

        for (const [action, binding] of Object.entries(bindings)) {
          if (normalizeKeyCombo(binding) === normalized) {
            return action
          }
        }
        return undefined
      },

      checkConflicts: () => {
        const conflicts = findConflicts(get().bindings)
        set({ conflicts })
        return conflicts
      },

      isModified: (action: string) => {
        const state = get()
        return state.bindings[action] !== state.defaultBindings[action]
      },
    }),
    {
      name: "cognia-canvas-keybindings",
      partialize: (state) => ({
        bindings: state.bindings,
      }),
    }
  )
)

// Re-exported from `lib/shortcuts/utils.ts` so existing canvas imports keep
// working without forcing a rename across the repo. The shared module is
// the source of truth — see Phase A.2 of the system-tray plan.
export const parseKeyEvent = parseKeyEventShared
export const formatKeybinding = formatKeybindingShared

export default useKeybindingStore
