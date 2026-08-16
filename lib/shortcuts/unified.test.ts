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

    it("does not flag the two ⌘K palettes against each other", () => {
      // app.commandPalette.toggle (when !view.workflowEditor) vs
      // workflow.commandPalette.toggle (when view.workflowEditor). Without the
      // exclusion neither could be rebound — the recorder would refuse the
      // chord each already owns.
      expect(findAppConflict("ctrl+k", "app.commandPalette.toggle")).toBeNull()
      expect(findAppConflict("ctrl+k", "workflow.commandPalette.toggle")).toBeNull()
    })

    it("returns null for the empty chord", () => {
      expect(findAppConflict("", "terminal.toggle")).toBeNull()
    })

    it("treats a conjunction that negates the other clause's term as exclusive", () => {
      // shell.sidebar.toggle (when !view.canvas && !platform.tauri) shares ⌘B
      // with canvasLayout.toggleLeft (when view.canvas): the `!view.canvas`
      // term alone rules out co-activation, so neither reports the other.
      expect(findAppConflict("ctrl+b", "shell.sidebar.toggle")).toBeNull()
      expect(findAppConflict("ctrl+b", "canvasLayout.toggleLeft")).toBeNull()
    })

    it("still flags a chord owned by a shortcut whose when clause is unrelated", () => {
      // No negated term in common → the two can co-activate → conflict.
      expect(findAppConflict("ctrl+f", "shell.conversation.next")).toBe("chat.search.toggle")
    })
  })

  it("resetAppShortcut restores the default", () => {
    rebindAppShortcut("terminal.toggle", "Ctrl+Shift+T")
    expect(useAppKeybindingStore.getState().isModified("terminal.toggle")).toBe(true)
    resetAppShortcut("terminal.toggle")
    expect(useAppKeybindingStore.getState().isModified("terminal.toggle")).toBe(false)
  })
})
