import {
  enterNormalFromInsert,
  handleVimNormalKey,
  handleVimReplaceKey,
  initialVimState,
  insertedTextBetween,
  nextVimSearchMatch,
  sealVimEntry,
  vimSearchMatches,
  type VimState,
} from "./vim"
import { insertText } from "./buffer"
import type { KeyFlags } from "./keymap"
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

// ── W1: replace mode, dot-repeat, draft search ───────────────────────────────

/**
 * Drive the interpreter the way the composer does: INSERT-mode chars edit the
 * buffer through `insertText` (the composer's default flow), Esc in INSERT
 * seals the pending `.` entry, and mode picks the handler. `steps` is a list
 * of `{ input, key }` — a bare string is shorthand for typing it.
 */
function drive(
  text: string,
  steps: ReadonlyArray<string | { input?: string; key?: KeyFlags }>,
  start: { row?: number; col?: number } = {}
) {
  let state = normal()
  let buffer = buf(text, start.row ?? 0, start.col ?? 0)
  const requests: string[] = []
  for (const raw of steps) {
    const step = typeof raw === "string" ? { input: raw } : raw
    const key = step.key ?? {}
    const input = step.input ?? ""
    if (state.mode === "insert") {
      if (key.escape) {
        state = { ...sealVimEntry(state, buffer), mode: "normal", pending: null, count: "" }
        buffer = enterNormalFromInsert(buffer)
        continue
      }
      if (!key.return && !key.ctrl && !key.meta && input) {
        buffer = insertText(buffer, input)
        continue
      }
    }
    const r =
      state.mode === "replace"
        ? handleVimReplaceKey(input, key, state, buffer)
        : handleVimNormalKey(input, key, state, buffer)
    state = r.state
    buffer = r.buffer
    if (r.request) requests.push(r.request)
  }
  return { state, buffer, requests }
}

describe("replace mode (R)", () => {
  it("R enters replace; typed chars overwrite instead of inserting", () => {
    const r = drive("hello", ["R", "HE"])
    expect(r.state.mode).toBe("replace")
    expect(r.buffer.lines[0]).toBe("HEllo")
    expect(r.buffer.cursorCol).toBe(2)
  })

  it("typing past end-of-line appends", () => {
    const r = drive("ab", ["R", "XYZ"], { col: 1 })
    expect(r.buffer.lines[0]).toBe("aXYZ")
  })

  it("backspace restores overwritten chars; at startCol it only moves", () => {
    const r = drive("hello", ["R", "XY", { key: { backspace: true } }])
    expect(r.buffer.lines[0]).toBe("Xello")
    expect(r.buffer.cursorCol).toBe(1)
    const r2 = drive("hello", [
      "R",
      "XY",
      { key: { backspace: true } },
      { key: { backspace: true } },
    ])
    expect(r2.buffer.lines[0]).toBe("hello")
    // R at col 1: type one char, backspace once restores it, backspace again
    // sits at startCol so it only moves the cursor left.
    const r3 = drive(
      "abcd",
      ["R", "Z", { key: { backspace: true } }, { key: { backspace: true } }],
      { col: 1 }
    )
    expect(r3.buffer.lines[0]).toBe("abcd")
    expect(r3.buffer.cursorCol).toBe(0)
  })

  it("Esc seals the session, drops to NORMAL with the cursor on the last char", () => {
    const r = drive("hello", ["R", "XY", { key: { escape: true } }])
    expect(r.state.mode).toBe("normal")
    expect(r.state.replace).toBeNull()
    expect(r.buffer.cursorCol).toBe(1)
    expect(r.state.lastChange).toEqual({ op: "replace", text: "XY" })
  })

  it("Enter submits; control chords fall through", () => {
    const enter = drive("abc", ["R", { key: { return: true } }])
    expect(enter.requests).toEqual(["submit"])
    const r = handleVimReplaceKey("c", { ctrl: true }, normal({ mode: "replace" }), buf("abc"))
    expect(r.handled).toBe(false)
  })
})

describe("dot-repeat (.)", () => {
  it("is a no-op before any change", () => {
    const r = feed("abc", ".")
    expect(r.buffer.lines[0]).toBe("abc")
  })

  it("repeats deletions: x, dd, dw, D", () => {
    expect(feed("abc", "x.").buffer.lines[0]).toBe("c")
    expect(feed("a\nb\nc", "dd.").buffer.lines).toEqual(["c"])
    expect(feed("one two three", "dw.").buffer.lines[0]).toBe("three")
    // D deleted to EOL leaving "o"; `.` at the clamped cursor deletes it too.
    expect(feed("one two", "lD.").buffer.lines[0]).toBe("")
  })

  it("repeats a paste", () => {
    expect(feed("abc", "xp.").buffer.lines[0]).toBe("baac")
  })

  it("repeats an insert: iX<Esc>. inserts X again at the new cursor", () => {
    const r = drive("abc", ["i", "X", { key: { escape: true } }, "."])
    expect(r.buffer.lines[0]).toBe("XXabc")
  })

  it("repeats a change: cwX<Esc>. at the next word swaps it too", () => {
    const r = drive("one two three", ["c", "w", "ONE ", { key: { escape: true } }, "w", "."])
    expect(r.buffer.lines[0]).toBe("ONE ONE three")
  })

  it("repeats open-line: o<Esc>. adds another line below", () => {
    const r = drive("a", ["o", "hi", { key: { escape: true } }, "."])
    expect(r.buffer.lines).toEqual(["a", "hi", "hi"])
  })

  it("repeats substitute and change-to-EOL", () => {
    // `.` replays AT the cursor — after `s`+Esc the cursor sits on the
    // inserted char, so move right first to substitute the next one.
    expect(drive("abc", ["s", "Z", { key: { escape: true } }, "l", "."]).buffer.lines[0]).toBe(
      "ZZc"
    )
    // "one two" → lC X Esc → "oX"; b to col 0, `.` changes to EOL again → "X".
    expect(
      drive("one two", ["l", "C", "X", { key: { escape: true } }, "b", "."]).buffer.lines[0]
    ).toBe("X")
  })

  it("repeats a replace session (overwrite semantics)", () => {
    // "XYllo" with the cursor on col 1; `.` overwrites "Yl" → "XXYlo".
    const r = drive("hello", ["R", "XY", { key: { escape: true } }, "."])
    expect(r.buffer.lines[0]).toBe("XXYlo")
  })

  it("an insert entry sealed with no text repeats just the structural op", () => {
    // `cw` + Esc without typing = `dw`; `.` deletes the next word.
    const r = drive("one two three", ["c", "w", { key: { escape: true } }, "."])
    expect(r.buffer.lines[0]).toBe("three")
  })
})

describe("seal + insertedTextBetween", () => {
  it("diffs the typed middle segment", () => {
    expect(insertedTextBetween("helloworld", "helloXXworld")).toBe("XX")
    expect(insertedTextBetween("ab", "ab")).toBe("")
    expect(insertedTextBetween("ab", "ab\nline")).toBe("\nline")
  })

  it("sealVimEntry is a no-op without a live entry", () => {
    const s = normal()
    expect(sealVimEntry(s, buf("abc"))).toBe(s)
  })
})

describe("draft search (/ ? n N)", () => {
  it("collects all literal matches per line for highlighting", () => {
    expect(vimSearchMatches(["foo bar foo", "zfoo"], "foo")).toEqual([
      { row: 0, start: 0, end: 3 },
      { row: 0, start: 8, end: 11 },
      { row: 1, start: 1, end: 4 },
    ])
    expect(vimSearchMatches(["abc"], "")).toEqual([])
  })

  it("/query + Enter lands on the first match from the cursor", () => {
    // incsearch positions while typing: "fo" hits the first "foo" at col 0.
    const r = drive("foo bar foo", ["/", "foo", { key: { return: true } }])
    expect(r.buffer.cursorCol).toBe(0)
    expect(r.state.lastSearch).toEqual({ dir: "fwd", query: "foo" })
  })

  it("n walks forward through matches and wraps; N reverses", () => {
    let r = drive("foo bar foo", ["/", "foo", { key: { return: true } }, "n"])
    expect(r.buffer.cursorCol).toBe(8)
    r = drive("foo bar foo", ["/", "foo", { key: { return: true } }, "n", "n"])
    expect(r.buffer.cursorCol).toBe(0) // wrapped
    r = drive("foo bar foo", ["/", "foo", { key: { return: true } }, "n", "N"])
    expect(r.buffer.cursorCol).toBe(0)
  })

  it("? searches backward and crosses lines", () => {
    const r = drive("foo a\nb foo", ["?", "foo", { key: { return: true } }], { row: 1, col: 5 })
    // incsearch: first `f` backward from (1,5) lands on row-1 "foo" at col 2.
    expect(r.buffer.cursorRow).toBe(1)
    expect(r.buffer.cursorCol).toBe(2)
    const r2 = drive("foo a\nb foo", ["?", "foo", { key: { return: true } }, "n"], {
      row: 1,
      col: 5,
    })
    expect(r2.buffer.cursorRow).toBe(0)
    expect(r2.buffer.cursorCol).toBe(0)
  })

  it("Esc cancels the entry without committing the search", () => {
    const r = drive("foo", ["/", "f", { key: { escape: true } }])
    expect(r.state.search).toBeNull()
    expect(r.state.lastSearch).toBeNull()
  })

  it("a no-match query leaves the cursor where it is", () => {
    const r = drive("abc", ["/", "zzz", { key: { return: true } }], { col: 1 })
    expect(r.buffer.cursorCol).toBe(1)
  })

  it("n/N with no committed search are no-ops", () => {
    expect(feed("abc", "n").buffer.cursorCol).toBe(0)
    expect(feed("abc", "N").buffer.cursorCol).toBe(0)
  })

  it("empty / + Enter repeats the previous search", () => {
    const r = drive("foo x foo", [
      "/",
      "foo",
      { key: { return: true } },
      "/",
      { key: { return: true } },
    ])
    expect(r.buffer.cursorCol).toBe(6)
  })

  it("backspace in the entry edits the query and repositions", () => {
    const r = drive("foo far", ["/", "foa", { key: { backspace: true } }])
    // "fo" still matches at col 0 (inclusive incsearch).
    expect(r.state.search?.query).toBe("fo")
    expect(r.buffer.cursorCol).toBe(0)
  })

  it("search entry swallows keys instead of editing the buffer", () => {
    const r = drive("abc", ["/", "x"])
    expect(r.buffer.lines[0]).toBe("abc")
    const ctrl = handleVimNormalKey(
      "c",
      { ctrl: true },
      normal({ search: { dir: "fwd", query: "x" } }),
      buf("abc")
    )
    expect(ctrl.handled).toBe(false)
  })

  it("nextVimSearchMatch is strict unless inclusive", () => {
    const b = buf("foo foo", 0, 0)
    expect(nextVimSearchMatch(b, { dir: "fwd", query: "foo" })).toEqual({ row: 0, col: 4 })
    expect(nextVimSearchMatch(b, { dir: "fwd", query: "foo" }, { inclusive: true })).toEqual({
      row: 0,
      col: 0,
    })
    expect(nextVimSearchMatch(b, { dir: "fwd", query: "zzz" })).toBeNull()
  })
})
