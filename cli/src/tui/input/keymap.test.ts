/**
 * @jest-environment node
 */
import { interpretKey, type KeyContext, type KeyFlags } from "./keymap"

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  popupOpen: false,
  onFirstLine: false,
  onLastLine: false,
  ...over,
})

const k = (over: Partial<KeyFlags> = {}): KeyFlags => ({ ...over })

describe("interpretKey", () => {
  it("Ctrl+C is handled by the App's global handler (no-op here)", () => {
    expect(interpretKey("c", k({ ctrl: true }), ctx())).toEqual({ type: "none" })
  })

  it("Escape interrupts, or cancels a popup", () => {
    expect(interpretKey("", k({ escape: true }), ctx())).toEqual({ type: "interrupt" })
    expect(interpretKey("", k({ escape: true }), ctx({ popupOpen: true }))).toEqual({
      type: "popup-cancel",
    })
  })

  it("Tab completes an open popup in place, else does nothing", () => {
    expect(interpretKey("", k({ tab: true }), ctx({ popupOpen: true }))).toEqual({
      type: "popup-complete",
    })
    expect(interpretKey("", k({ tab: true }), ctx())).toEqual({ type: "none" })
  })

  it("Enter submits; Shift/Meta+Enter is a newline; popup accepts", () => {
    expect(interpretKey("", k({ return: true }), ctx())).toEqual({ type: "submit" })
    expect(interpretKey("", k({ return: true, shift: true }), ctx())).toEqual({ type: "newline" })
    expect(interpretKey("", k({ return: true, meta: true }), ctx())).toEqual({ type: "newline" })
    expect(interpretKey("", k({ return: true }), ctx({ popupOpen: true }))).toEqual({
      type: "popup-accept",
    })
  })

  it("Up/Down move the popup, navigate history, or move the cursor", () => {
    expect(interpretKey("", k({ upArrow: true }), ctx({ popupOpen: true }))).toEqual({
      type: "popup-move",
      delta: -1,
    })
    expect(interpretKey("", k({ downArrow: true }), ctx({ popupOpen: true }))).toEqual({
      type: "popup-move",
      delta: 1,
    })
    expect(interpretKey("", k({ upArrow: true }), ctx({ onFirstLine: true }))).toEqual({
      type: "history",
      dir: "up",
    })
    expect(interpretKey("", k({ upArrow: true }), ctx({ onFirstLine: false }))).toEqual({
      type: "move",
      dir: "up",
    })
    expect(interpretKey("", k({ downArrow: true }), ctx({ onLastLine: true }))).toEqual({
      type: "history",
      dir: "down",
    })
    expect(interpretKey("", k({ downArrow: true }), ctx({ onLastLine: false }))).toEqual({
      type: "move",
      dir: "down",
    })
  })

  it("Left/Right move the cursor; Ctrl/Alt+Left/Right jump by word", () => {
    expect(interpretKey("", k({ leftArrow: true }), ctx())).toEqual({ type: "move", dir: "left" })
    expect(interpretKey("", k({ rightArrow: true }), ctx())).toEqual({ type: "move", dir: "right" })
    expect(interpretKey("", k({ leftArrow: true, ctrl: true }), ctx())).toEqual({
      type: "move",
      dir: "word-left",
    })
    expect(interpretKey("", k({ rightArrow: true, ctrl: true }), ctx())).toEqual({
      type: "move",
      dir: "word-right",
    })
    expect(interpretKey("", k({ leftArrow: true, meta: true }), ctx())).toEqual({
      type: "move",
      dir: "word-left",
    })
  })

  it("Backspace / Delete delete the previous character", () => {
    expect(interpretKey("", k({ backspace: true }), ctx())).toEqual({ type: "backspace" })
    expect(interpretKey("", k({ delete: true }), ctx())).toEqual({ type: "backspace" })
  })

  it("emacs motions, word delete, and line kills", () => {
    expect(interpretKey("a", k({ ctrl: true }), ctx())).toEqual({ type: "move", dir: "home" })
    expect(interpretKey("e", k({ ctrl: true }), ctx())).toEqual({ type: "move", dir: "end" })
    expect(interpretKey("w", k({ ctrl: true }), ctx())).toEqual({ type: "delete-word" })
    expect(interpretKey("u", k({ ctrl: true }), ctx())).toEqual({ type: "kill-to-start" })
    expect(interpretKey("k", k({ ctrl: true }), ctx())).toEqual({ type: "kill-to-end" })
  })

  it("printable text inserts; unknown control chords are ignored", () => {
    expect(interpretKey("x", k(), ctx())).toEqual({ type: "insert", text: "x" })
    expect(interpretKey("p", k({ ctrl: true }), ctx())).toEqual({ type: "none" })
    expect(interpretKey("", k(), ctx())).toEqual({ type: "none" })
  })

  it("maps the undo/redo chords (Ctrl+Z / Ctrl+Y)", () => {
    expect(interpretKey("z", k({ ctrl: true }), ctx())).toEqual({ type: "undo" })
    expect(interpretKey("y", k({ ctrl: true }), ctx())).toEqual({ type: "redo" })
  })

  it("honours custom editor-chord bindings", () => {
    // Rebind line-home to ctrl+b: the new key fires, the old one no longer does.
    const bindings = { lineHome: "ctrl+b", lineEnd: "ctrl+e", deleteWord: "ctrl+w" }
    expect(interpretKey("b", k({ ctrl: true }), ctx(), bindings)).toEqual({
      type: "move",
      dir: "home",
    })
    expect(interpretKey("a", k({ ctrl: true }), ctx(), bindings)).toEqual({ type: "none" })
  })
})
