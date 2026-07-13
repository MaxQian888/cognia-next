/** @jest-environment jsdom */
import { normalizeKeyCombo, parseKeyEvent, formatKeybinding } from "./utils"

describe("normalizeKeyCombo", () => {
  it("lowercases, trims and joins on '+'", () => {
    expect(normalizeKeyCombo("Ctrl + S ")).toBe("ctrl+s")
  })

  it("sorts modifiers in ctrl/alt/shift/meta order", () => {
    expect(normalizeKeyCombo("Shift+Ctrl+Alt+Meta+K")).toBe("ctrl+alt+shift+meta+k")
  })

  it("places non-modifier keys after modifiers and sorts them lexicographically", () => {
    expect(normalizeKeyCombo("B+A+Ctrl")).toBe("ctrl+a+b")
  })

  it("is idempotent on already-normalized input", () => {
    expect(normalizeKeyCombo("ctrl+shift+s")).toBe("ctrl+shift+s")
  })
})

describe("parseKeyEvent", () => {
  it("captures Ctrl + letter", () => {
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true })
    expect(parseKeyEvent(event)).toBe("Ctrl+S")
  })

  it("treats metaKey as ctrl (platform-agnostic chord shape)", () => {
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true })
    expect(parseKeyEvent(event)).toBe("Ctrl+K")
  })

  it("captures multiple modifiers in canonical order", () => {
    const event = new KeyboardEvent("keydown", {
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    })
    expect(parseKeyEvent(event)).toBe("Ctrl+Alt+Shift+Z")
  })

  it("ignores naked modifier presses (key === 'Control')", () => {
    const event = new KeyboardEvent("keydown", { key: "Control", ctrlKey: true })
    expect(parseKeyEvent(event)).toBe("Ctrl")
  })

  it("preserves multi-char special keys verbatim", () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true })
    expect(parseKeyEvent(event)).toBe("Ctrl+Enter")
  })

  it("folds the Shift '+' key back to '=' so it never collides with the separator", () => {
    const event = new KeyboardEvent("keydown", { key: "+", ctrlKey: true, shiftKey: true })
    expect(parseKeyEvent(event)).toBe("Ctrl+Shift+=")
  })

  it("folds the Shift '_' key back to '-'", () => {
    const event = new KeyboardEvent("keydown", { key: "_", ctrlKey: true, shiftKey: true })
    expect(parseKeyEvent(event)).toBe("Ctrl+Shift+-")
  })

  it("names the Space key so it survives normalization", () => {
    const event = new KeyboardEvent("keydown", { key: " ", ctrlKey: true, shiftKey: true })
    expect(parseKeyEvent(event)).toBe("Ctrl+Shift+Space")
    expect(normalizeKeyCombo(parseKeyEvent(event))).toBe("ctrl+shift+space")
  })
})

describe("formatKeybinding", () => {
  function withPlatform(platform: string, fn: () => void) {
    const desc = Object.getOwnPropertyDescriptor(window.navigator, "platform")
    Object.defineProperty(window.navigator, "platform", { configurable: true, get: () => platform })
    try {
      fn()
    } finally {
      if (desc) Object.defineProperty(window.navigator, "platform", desc)
      else
        Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Win32" })
    }
  }

  it("keeps '+' joiner and literal modifier names on non-Mac", () => {
    withPlatform("Win32", () => {
      expect(formatKeybinding("Ctrl+Shift+S")).toBe("Ctrl+Shift+S")
    })
  })

  it("collapses modifiers to glyphs with no joiner on Mac", () => {
    withPlatform("MacIntel", () => {
      const formatted = formatKeybinding("Ctrl+Alt+Shift+S")
      expect(formatted).toContain("⌘")
      expect(formatted).toContain("⌥")
      expect(formatted).toContain("⇧")
      expect(formatted).not.toContain("+")
    })
  })
})
