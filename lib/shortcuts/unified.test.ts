/** @jest-environment jsdom */

import {
  getAppShortcutGroups,
  findAppConflict,
  rebindAppShortcut,
  resetAppShortcut,
} from "./unified"
import {
  useAppKeybindingStore,
  __resetAppKeybindingStoreForTesting,
} from "@/stores/shortcuts/app-keybinding-store"

describe("unified app-shortcut facade", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetAppKeybindingStoreForTesting()
  })

  describe("getAppShortcutGroups", () => {
    it("groups editable app shortcuts by category with live chords", () => {
      const groups = getAppShortcutGroups()
      const categories = groups.map((g) => g.category)
      expect(categories).toContain("app.terminal")
      expect(categories).toContain("app.zoom")

      const terminal = groups
        .flatMap((g) => g.rows)
        .find((r) => r.descriptor.id === "terminal.toggle")
      expect(terminal?.chord).toBe("ctrl+`")
      expect(terminal?.isModified).toBe(false)
    })

    it("reflects an override in the row chord + modified flag", () => {
      rebindAppShortcut("terminal.toggle", "Ctrl+Shift+T")
      const terminal = getAppShortcutGroups()
        .flatMap((g) => g.rows)
        .find((r) => r.descriptor.id === "terminal.toggle")
      expect(terminal?.chord).toBe("ctrl+shift+t")
      expect(terminal?.isModified).toBe(true)
    })
  })

  describe("findAppConflict", () => {
    it("flags another shortcut that owns the same chord", () => {
      // terminal.toggle defaults to ctrl+`; rebinding zoom.in onto it collides.
      expect(findAppConflict("ctrl+`", "zoom.in")).toBe("terminal.toggle")
    })

    it("ignores the shortcut being edited", () => {
      expect(findAppConflict("ctrl+`", "terminal.toggle")).toBeNull()
    })

    it("returns null for a free chord", () => {
      expect(findAppConflict("ctrl+alt+shift+q", "terminal.toggle")).toBeNull()
    })

    it("does not flag shortcuts whose when clauses are exact negations", () => {
      // artifacts.toggleDock (when !view.canvas) vs canvasLayout.toggleRight
      // (when view.canvas) both default to ctrl+j but can never both be active.
      expect(findAppConflict("ctrl+j", "artifacts.toggleDock")).toBeNull()
    })

    it("returns null for the empty chord", () => {
      expect(findAppConflict("", "terminal.toggle")).toBeNull()
    })
  })

  it("resetAppShortcut restores the default", () => {
    rebindAppShortcut("terminal.toggle", "Ctrl+Shift+T")
    expect(useAppKeybindingStore.getState().isModified("terminal.toggle")).toBe(true)
    resetAppShortcut("terminal.toggle")
    expect(useAppKeybindingStore.getState().isModified("terminal.toggle")).toBe(false)
  })
})
