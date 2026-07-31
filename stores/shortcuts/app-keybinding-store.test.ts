/** @jest-environment jsdom */

import { useAppKeybindingStore, __resetAppKeybindingStoreForTesting } from "./app-keybinding-store"

const store = () => useAppKeybindingStore.getState()

describe("app-keybinding-store", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetAppKeybindingStoreForTesting()
  })

  it("returns the catalog default chord when no override exists", () => {
    expect(store().getChord("terminal.toggle")).toBe("ctrl+`")
    expect(store().isModified("terminal.toggle")).toBe(false)
  })

  it("returns an empty string for an unknown id with no override", () => {
    expect(store().getChord("nope")).toBe("")
  })

  it("normalizes and applies an override", () => {
    store().setOverride("terminal.toggle", "Ctrl+Shift+T")
    expect(store().getChord("terminal.toggle")).toBe("ctrl+shift+t")
    expect(store().isModified("terminal.toggle")).toBe(true)
  })

  it("resetOverride restores the default", () => {
    store().setOverride("terminal.toggle", "Ctrl+Shift+T")
    store().resetOverride("terminal.toggle")
    expect(store().getChord("terminal.toggle")).toBe("ctrl+`")
    expect(store().isModified("terminal.toggle")).toBe(false)
  })

  it("resetOverride is a no-op when the id was never overridden", () => {
    store().resetOverride("terminal.toggle")
    expect(store().overrides).toEqual({})
  })

  it("resetAll clears every override", () => {
    store().setOverride("terminal.toggle", "Ctrl+Shift+T")
    store().setOverride("app.search.focus", "Ctrl+P")
    store().resetAll()
    expect(store().overrides).toEqual({})
  })

  describe("getAcceptedChords", () => {
    it("returns default + alt chords when not overridden", () => {
      expect(store().getAcceptedChords("zoom.in")).toEqual(["ctrl+=", "ctrl+shift+="])
    })

    it("returns exactly the override (dropping alts) when overridden", () => {
      store().setOverride("zoom.in", "Ctrl+Alt+I")
      expect(store().getAcceptedChords("zoom.in")).toEqual(["ctrl+alt+i"])
    })

    it("returns an empty list when the shortcut is cleared to nothing", () => {
      store().setOverride("terminal.toggle", "")
      expect(store().getAcceptedChords("terminal.toggle")).toEqual([])
      expect(store().getChord("terminal.toggle")).toBe("")
    })
  })

  describe("getActionByChord", () => {
    it("finds the action bound to a default chord", () => {
      expect(store().getActionByChord("Ctrl+`")).toBe("terminal.toggle")
    })

    it("follows an override to the new chord", () => {
      store().setOverride("app.search.focus", "Ctrl+P")
      expect(store().getActionByChord("Ctrl+P")).toBe("app.search.focus")
      // "/" moved off app.search.focus. (Another catalog action — skills.search —
      // also defaults to "/", so the lookup may resolve to that instead; the
      // point is app.search.focus no longer owns it.)
      expect(store().getActionByChord("/")).not.toBe("app.search.focus")
    })

    it("returns undefined when no action owns the chord", () => {
      expect(store().getActionByChord("Ctrl+Shift+Q")).toBeUndefined()
    })
  })

  it("persists overrides to localStorage under the sparse key", () => {
    store().setOverride("terminal.toggle", "Ctrl+Shift+T")
    const raw = localStorage.getItem("cognia-app-keybindings")
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state.overrides).toEqual({ "terminal.toggle": "ctrl+shift+t" })
  })
})
