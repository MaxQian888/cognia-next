import { enterNormalFromInsert, handleVimNormalKey, initialVimState, type VimState } from "./vim"
import type { InputBuffer } from "../state/types"

const buf = (text: string, row = 0, col = 0): InputBuffer => ({
  lines: text.split("\n"),
  cursorRow: row,
  cursorCol: col,
})

const normal = (over: Partial<VimState> = {}): VimState => ({
  ...initialVimState(),
  mode: "normal",
  ...over,
})

/** Feed a key sequence through the interpreter, collecting requests. */
function feed(text: string, keys: string, start: { row?: number; col?: number } = {}) {
  let state = normal()
  let buffer = buf(text, start.row ?? 0, start.col ?? 0)
  const requests: string[] = []
  for (const ch of keys) {
    const r = handleVimNormalKey(ch, {}, state, buffer)
    state = r.state
    buffer = r.buffer
    if (r.request) requests.push(r.request)
  }
  return { state, buffer, requests }
}

describe("enterNormalFromInsert", () => {
  it("pulls the cursor one column left, clamped to the line", () => {
    expect(enterNormalFromInsert(buf("hello", 0, 5)).cursorCol).toBe(4)
    expect(enterNormalFromInsert(buf("hello", 0, 0)).cursorCol).toBe(0)
    expect(enterNormalFromInsert(buf("", 0, 0)).cursorCol).toBe(0)
  })
})

describe("motions", () => {
  it("h/l/j/k move with clamping", () => {
    expect(feed("abc\ndef", "l").buffer.cursorCol).toBe(1)
    expect(feed("abc\ndef", "lh").buffer.cursorCol).toBe(0)
    expect(feed("abc\ndef", "j").buffer.cursorRow).toBe(1)
    expect(feed("abc\ndef", "jk").buffer.cursorRow).toBe(0)
    // clamp: never past line end in NORMAL
    expect(feed("ab", "llllll").buffer.cursorCol).toBe(1)
  })

  it("counts multiply motions (3l)", () => {
    expect(feed("abcdef", "3l").buffer.cursorCol).toBe(3)
  })

  it("0 ^ $ jump within the line", () => {
    expect(feed("  hi there", "$", { col: 0 }).buffer.cursorCol).toBe(9)
    expect(feed("  hi there", "$0").buffer.cursorCol).toBe(0)
    expect(feed("  hi there", "^").buffer.cursorCol).toBe(2)
  })

  it("w/b/e word motions", () => {
    expect(feed("one two three", "w").buffer.cursorCol).toBe(4)
    expect(feed("one two three", "ww").buffer.cursorCol).toBe(8)
    expect(feed("one two three", "wb").buffer.cursorCol).toBe(0)
    expect(feed("one two", "e").buffer.cursorCol).toBe(2)
  })

  it("gg and G jump to first/last line (with counts)", () => {
    expect(feed("a\nb\nc", "G").buffer.cursorRow).toBe(2)
    expect(feed("a\nb\nc", "Ggg").buffer.cursorRow).toBe(0)
    expect(feed("a\nb\nc", "2G").buffer.cursorRow).toBe(1)
  })

  it("arrows and backspace move (never delete)", () => {
    let r = handleVimNormalKey("", { rightArrow: true }, normal(), buf("abc"))
    expect(r.buffer.cursorCol).toBe(1)
    r = handleVimNormalKey("", { backspace: true }, normal(), buf("abc", 0, 2))
    expect(r.buffer.cursorCol).toBe(1)
    expect(r.buffer.lines[0]).toBe("abc")
  })
})

describe("mode changes", () => {
  it.each([
    ["i", 1, 1],
    ["a", 1, 2],
    ["I", 1, 0],
    ["A", 1, 5],
  ])("%s enters insert with the right cursor", (k, col, expected) => {
    const r = handleVimNormalKey(k, {}, normal(), buf("hello", 0, col))
    expect(r.state.mode).toBe("insert")
    expect(r.buffer.cursorCol).toBe(expected)
  })

  it("o/O open a line below/above and insert", () => {
    const o = handleVimNormalKey("o", {}, normal(), buf("a\nb", 0, 0))
    expect(o.buffer.lines).toEqual(["a", "", "b"])
    expect(o.buffer.cursorRow).toBe(1)
    expect(o.state.mode).toBe("insert")
    const O = handleVimNormalKey("O", {}, normal(), buf("a\nb", 1, 0))
    expect(O.buffer.lines).toEqual(["a", "", "b"])
    expect(O.buffer.cursorRow).toBe(1)
  })
})

describe("edits", () => {
  it("x deletes under the cursor (with count) into the register", () => {
    const r = feed("abcdef", "2x")
    expect(r.buffer.lines[0]).toBe("cdef")
    expect(r.state.register).toEqual({ text: "ab", linewise: false })
  })

  it("X deletes left of the cursor", () => {
    expect(feed("abc", "X", { col: 1 }).buffer.lines[0]).toBe("bc")
  })

  it("dd deletes lines linewise (count) and never empties the buffer", () => {
    const r = feed("a\nb\nc", "2dd")
    expect(r.buffer.lines).toEqual(["c"])
    expect(r.state.register).toEqual({ text: "a\nb", linewise: true })
    expect(feed("only", "dd").buffer.lines).toEqual([""])
  })

  it("dw/de/d$ delete charwise spans on the line", () => {
    expect(feed("one two three", "dw").buffer.lines[0]).toBe("two three")
    expect(feed("one two", "de").buffer.lines[0]).toBe(" two")
    expect(feed("one two", "d$", { col: 3 }).buffer.lines[0]).toBe("one")
  })

  it("D and C cut to line end; C enters insert", () => {
    expect(feed("hello world", "D", { col: 5 }).buffer.lines[0]).toBe("hello")
    const c = feed("hello world", "C", { col: 5 })
    expect(c.buffer.lines[0]).toBe("hello")
    expect(c.state.mode).toBe("insert")
  })

  it("cw deletes the word and enters insert at the span start", () => {
    const r = feed("one two", "cw")
    expect(r.buffer.lines[0]).toBe("two")
    expect(r.state.mode).toBe("insert")
    expect(r.buffer.cursorCol).toBe(0)
  })

  it("cc reopens the line empty in insert mode", () => {
    const r = feed("aaa\nbbb", "cc")
    expect(r.buffer.lines).toEqual(["", "bbb"])
    expect(r.state.mode).toBe("insert")
    expect(r.state.register).toEqual({ text: "aaa", linewise: true })
  })

  it("s substitutes the char; S substitutes the line", () => {
    const s = feed("abc", "s")
    expect(s.buffer.lines[0]).toBe("bc")
    expect(s.state.mode).toBe("insert")
    const S = feed("abc", "S", { col: 2 })
    expect(S.buffer.lines[0]).toBe("")
    expect(S.state.mode).toBe("insert")
  })

  it("yy + p pastes linewise below; P above", () => {
    const p = feed("a\nb", "yyjp")
    expect(p.buffer.lines).toEqual(["a", "b", "a"])
    expect(p.buffer.cursorRow).toBe(2)
    const P = feed("a\nb", "yyjP")
    expect(P.buffer.lines).toEqual(["a", "a", "b"])
  })

  it("x + p pastes charwise after the cursor", () => {
    const r = feed("abc", "xp")
    // x cuts "a" (cursor on "b"), p pastes after → "bac"
    expect(r.buffer.lines[0]).toBe("bac")
  })

  it("p with an empty register is a no-op", () => {
    expect(feed("abc", "p").buffer.lines[0]).toBe("abc")
  })
})

describe("requests + fallthrough", () => {
  it("u requests undo; Ctrl+R requests redo", () => {
    expect(feed("abc", "u").requests).toEqual(["undo"])
    const r = handleVimNormalKey("r", { ctrl: true }, normal(), buf("abc"))
    expect(r.request).toBe("redo")
    expect(r.handled).toBe(true)
  })

  it("Enter requests submit", () => {
    const r = handleVimNormalKey("", { return: true }, normal(), buf("abc"))
    expect(r.request).toBe("submit")
  })

  it("Esc clears a pending operator/count", () => {
    let state = normal()
    state = handleVimNormalKey("d", {}, state, buf("abc")).state
    expect(state.pending).toBe("d")
    state = handleVimNormalKey("", { escape: true }, state, buf("abc")).state
    expect(state.pending).toBeNull()
  })

  it("hands other control chords back to the default flow", () => {
    const r = handleVimNormalKey("f", { ctrl: true }, normal(), buf("abc"))
    expect(r.handled).toBe(false)
  })

  it("swallows unknown printable keys instead of inserting", () => {
    const r = handleVimNormalKey("z", {}, normal(), buf("abc"))
    expect(r.handled).toBe(true)
    expect(r.buffer.lines[0]).toBe("abc")
  })

  it("unknown operator motion drops the operator without editing", () => {
    const r = feed("abc def", "dz")
    expect(r.buffer.lines[0]).toBe("abc def")
    expect(r.state.pending).toBeNull()
  })
})
