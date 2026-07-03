import { keyComboToMonaco } from "./keybinding-monaco"

// Minimal stand-in for the Monaco namespace. Values mirror Monaco's real
// KeyMod bit flags; KeyCode members only need to be distinct numbers for the
// assertions. `chord` uses Monaco's low/high-word packing so we can assert the
// composed number.
const KeyMod = {
  CtrlCmd: 2048,
  Shift: 1024,
  Alt: 512,
  WinCtrl: 256,
  chord: (first: number, second: number) => (first & 0xffff) | ((second & 0xffff) << 16),
}

const KeyCode: Record<string, number> = {
  KeyA: 31,
  KeyK: 41,
  KeyS: 49,
  KeyZ: 56,
  Digit0: 21,
  Digit1: 22,
  F1: 59,
  F11: 69,
  Enter: 3,
  Escape: 9,
  Tab: 2,
  BracketRight: 88,
  BracketLeft: 87,
  Slash: 85,
  Backquote: 86,
  Period: 84,
}

const monaco = { KeyMod, KeyCode }

describe("keyComboToMonaco", () => {
  it("resolves a single modifier + letter", () => {
    expect(keyComboToMonaco("Ctrl+S", monaco)).toBe(KeyMod.CtrlCmd | KeyCode.KeyS)
  })

  it("combines multiple modifiers regardless of order", () => {
    expect(keyComboToMonaco("Ctrl+Shift+S", monaco)).toBe(
      KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS
    )
    expect(keyComboToMonaco("Shift+Ctrl+S", monaco)).toBe(
      KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS
    )
  })

  it("folds Meta/Cmd into CtrlCmd", () => {
    expect(keyComboToMonaco("Meta+S", monaco)).toBe(KeyMod.CtrlCmd | KeyCode.KeyS)
    expect(keyComboToMonaco("Cmd+K", monaco)).toBe(KeyMod.CtrlCmd | KeyCode.KeyK)
  })

  it("maps Alt and punctuation keys", () => {
    expect(keyComboToMonaco("Alt+]", monaco)).toBe(KeyMod.Alt | KeyCode.BracketRight)
    expect(keyComboToMonaco("Alt+[", monaco)).toBe(KeyMod.Alt | KeyCode.BracketLeft)
  })

  it("maps digits, function keys, and named keys", () => {
    expect(keyComboToMonaco("Ctrl+1", monaco)).toBe(KeyMod.CtrlCmd | KeyCode.Digit1)
    expect(keyComboToMonaco("F11", monaco)).toBe(KeyCode.F11)
    expect(keyComboToMonaco("Ctrl+Enter", monaco)).toBe(KeyMod.CtrlCmd | KeyCode.Enter)
    expect(keyComboToMonaco("Escape", monaco)).toBe(KeyCode.Escape)
  })

  it("is case-insensitive on key and modifier tokens", () => {
    expect(keyComboToMonaco("ctrl+shift+s", monaco)).toBe(
      KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS
    )
  })

  it("resolves two-stroke chords via KeyMod.chord", () => {
    const first = KeyMod.CtrlCmd | KeyCode.KeyK
    const second = KeyMod.CtrlCmd | KeyCode.Digit0
    expect(keyComboToMonaco("Ctrl+K Ctrl+0", monaco)).toBe(KeyMod.chord(first, second))
  })

  it("returns null for empty, modifier-only, or unmapped combos", () => {
    expect(keyComboToMonaco("", monaco)).toBeNull()
    expect(keyComboToMonaco("Ctrl+Shift", monaco)).toBeNull()
    expect(keyComboToMonaco("Ctrl+😀", monaco)).toBeNull()
  })

  it("returns null when a chord stroke is unresolvable", () => {
    expect(keyComboToMonaco("Ctrl+K Ctrl+Shift", monaco)).toBeNull()
  })

  it("returns null when the monaco namespace is unavailable", () => {
    expect(keyComboToMonaco("Ctrl+S", null)).toBeNull()
    expect(keyComboToMonaco("Ctrl+S", {})).toBeNull()
  })

  it("returns null for keys of each family missing from the KeyCode table", () => {
    // The stub omits KeyB / Digit5 / F2 / Home, exercising every resolver's
    // null path (letter, digit, function key, named key).
    expect(keyComboToMonaco("Ctrl+B", monaco)).toBeNull()
    expect(keyComboToMonaco("Ctrl+5", monaco)).toBeNull()
    expect(keyComboToMonaco("F2", monaco)).toBeNull()
    expect(keyComboToMonaco("Home", monaco)).toBeNull()
  })

  it("returns null for a whitespace-only combo", () => {
    expect(keyComboToMonaco("   ", monaco)).toBeNull()
  })
})
