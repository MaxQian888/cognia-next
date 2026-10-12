import { composerSendKeys, formatKeyCombo } from "./composer-send-keys"

describe("composerSendKeys", () => {
  it("documents Enter to send and Shift+Enter for a newline by default", () => {
    expect(composerSendKeys({ sendOnEnter: true, appleGlyphs: true })).toEqual({
      send: ["⏎"],
      newline: ["⇧", "⏎"],
    })
  })

  it("documents the modifier chord once Enter no longer sends", () => {
    expect(composerSendKeys({ sendOnEnter: false, appleGlyphs: true })).toEqual({
      send: ["⌘", "⏎"],
      newline: ["⏎"],
    })
    expect(composerSendKeys({ sendOnEnter: false, appleGlyphs: false })).toEqual({
      send: ["Ctrl", "⏎"],
      newline: ["⏎"],
    })
  })
})

describe("formatKeyCombo", () => {
  it("runs glyph chords together and joins word modifiers with +", () => {
    expect(formatKeyCombo(["⇧", "⏎"])).toBe("⇧⏎")
    expect(formatKeyCombo(["⌘", "⏎"])).toBe("⌘⏎")
    expect(formatKeyCombo(["Ctrl", "⏎"])).toBe("Ctrl+⏎")
    expect(formatKeyCombo(["⏎"])).toBe("⏎")
  })
})
