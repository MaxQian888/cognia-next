import { getReservedShortcutConflict } from "./reserved"

describe("getReservedShortcutConflict", () => {
  it("flags a macOS system shortcut (Cmd/Ctrl folded)", () => {
    const hit = getReservedShortcutConflict("Ctrl+Space", "macos")
    expect(hit).toEqual({ chord: "ctrl+space", feature: "Spotlight", os: "macos" })
  })

  it("flags a Windows system shortcut", () => {
    expect(getReservedShortcutConflict("Ctrl+Alt+Delete", "windows")?.feature).toBe(
      "Security screen"
    )
    expect(getReservedShortcutConflict("Alt+Tab", "windows")?.feature).toBe("App switcher")
  })

  it("flags a Linux system shortcut", () => {
    expect(getReservedShortcutConflict("Ctrl+Alt+T", "linux")?.feature).toBe("Terminal")
  })

  it("normalizes the input chord before matching", () => {
    // Un-normalized, differently-ordered modifiers still match.
    expect(getReservedShortcutConflict("shift+ctrl+3", "macos")?.feature).toBe("Screenshot")
  })

  it("is platform-specific — a macOS-only chord is free on Windows", () => {
    expect(getReservedShortcutConflict("Ctrl+Space", "windows")).toBeNull()
  })

  it("returns null for a free chord", () => {
    expect(getReservedShortcutConflict("Ctrl+Alt+Shift+J", "macos")).toBeNull()
  })

  it("returns null for the empty chord and unknown OS", () => {
    expect(getReservedShortcutConflict("", "macos")).toBeNull()
    expect(getReservedShortcutConflict("Ctrl+Space", "unknown")).toBeNull()
  })
})
