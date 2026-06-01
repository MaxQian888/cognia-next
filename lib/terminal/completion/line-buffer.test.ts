import { EMPTY_LINE, feedInput, isSuggestible, resetLine } from "./line-buffer"

/** Feed a sequence of chunks starting from a fresh line. */
function feedAll(chunks: string[]) {
  let state = resetLine()
  for (const c of chunks) state = feedInput(state, c)
  return state
}

describe("resetLine / EMPTY_LINE", () => {
  it("starts empty, tracked, cursor 0", () => {
    expect(resetLine()).toEqual({ text: "", cursor: 0, tracked: true })
    expect(EMPTY_LINE).toEqual({ text: "", cursor: 0, tracked: true })
  })
  it("returns a fresh object each call (no shared mutation)", () => {
    const a = resetLine()
    const b = resetLine()
    expect(a).not.toBe(b)
  })
})

describe("feedInput — printable input", () => {
  it("appends single characters at the cursor", () => {
    const s = feedAll(["g", "i", "t"])
    expect(s).toEqual({ text: "git", cursor: 3, tracked: true })
  })
  it("inserts a pasted printable run as one chunk", () => {
    const s = feedAll(["git ", "status"])
    expect(s.text).toBe("git status")
    expect(s.cursor).toBe(10)
  })
  it("inserts in the middle when the cursor was moved left", () => {
    let s = feedAll(["g", "t"]) // "gt", cursor 2
    s = feedInput(s, "\x1b[D") // left → cursor 1
    s = feedInput(s, "i") // insert between g and t
    expect(s.text).toBe("git")
    expect(s.cursor).toBe(2)
  })
})

describe("feedInput — editing keys", () => {
  it("backspace (DEL) deletes the char before the cursor", () => {
    const s = feedAll(["l", "s", "x", "\x7f"])
    expect(s.text).toBe("ls")
    expect(s.cursor).toBe(2)
  })
  it("backspace (BS) behaves the same", () => {
    const s = feedAll(["a", "\b"])
    expect(s.text).toBe("")
  })
  it("backspace at column 0 is a no-op", () => {
    let s = resetLine()
    s = feedInput(s, "\x7f")
    expect(s).toEqual({ text: "", cursor: 0, tracked: true })
  })
  it("forward-delete (ESC [ 3 ~) removes the char at the cursor", () => {
    let s = feedAll(["a", "b", "c"])
    s = feedInput(s, "\x1b[D")
    s = feedInput(s, "\x1b[D") // cursor at 1 (between a and b)
    s = feedInput(s, "\x1b[3~")
    expect(s.text).toBe("ac")
    expect(s.cursor).toBe(1)
  })
  it("Ctrl+U kills from start to cursor", () => {
    let s = feedAll(["e", "c", "h", "o", " ", "h", "i"]) // "echo hi"
    s = feedInput(s, "\x01") // home
    s = feedInput(s, "\x1b[C") // right → cursor 1
    s = feedInput(s, "\x15") // kill to start
    expect(s.text).toBe("cho hi")
    expect(s.cursor).toBe(0)
  })
  it("Ctrl+K kills from cursor to end", () => {
    let s = feedAll(["e", "c", "h", "o"])
    s = feedInput(s, "\x1b[D")
    s = feedInput(s, "\x1b[D") // cursor 2
    s = feedInput(s, "\x0b")
    expect(s.text).toBe("ec")
    expect(s.cursor).toBe(2)
  })
  it("Ctrl+W deletes the previous word incl. trailing spaces", () => {
    const s = feedAll(["g", "i", "t", " ", "p", "u", "s", "h", "\x17"])
    expect(s.text).toBe("git ")
    expect(s.cursor).toBe(4)
  })
  it("Ctrl+A / Ctrl+E move to start / end", () => {
    let s = feedAll(["a", "b"])
    s = feedInput(s, "\x01")
    expect(s.cursor).toBe(0)
    s = feedInput(s, "\x05")
    expect(s.cursor).toBe(2)
  })
})

describe("feedInput — cursor movement clamping", () => {
  it("left arrow floors at 0, right arrow caps at length", () => {
    let s = feedAll(["x"])
    s = feedInput(s, "\x1b[D")
    s = feedInput(s, "\x1b[D") // can't go below 0
    expect(s.cursor).toBe(0)
    s = feedInput(s, "\x1b[C")
    s = feedInput(s, "\x1b[C") // can't exceed length
    expect(s.cursor).toBe(1)
  })
  it("Home/End escape variants move the cursor", () => {
    let s = feedAll(["a", "b", "c"])
    s = feedInput(s, "\x1b[H")
    expect(s.cursor).toBe(0)
    s = feedInput(s, "\x1b[F")
    expect(s.cursor).toBe(3)
  })
})

describe("feedInput — submit & cancel reset the line", () => {
  it("Enter (CR) clears to a fresh tracked line", () => {
    const s = feedAll(["l", "s", "\r"])
    expect(s).toEqual({ text: "", cursor: 0, tracked: true })
  })
  it("Enter (LF) also clears", () => {
    expect(feedAll(["l", "s", "\n"]).text).toBe("")
  })
  it("Ctrl+C cancels to a fresh tracked line", () => {
    expect(feedAll(["r", "m", " ", "-", "r", "f", "\x03"])).toEqual({
      text: "",
      cursor: 0,
      tracked: true,
    })
  })
})

describe("feedInput — untracking on unmodellable input", () => {
  it("history recall (up arrow) marks the line untracked", () => {
    const s = feedAll(["l", "s", "\x1b[A"])
    expect(s.tracked).toBe(false)
  })
  it("Tab (shell completion) marks the line untracked", () => {
    expect(feedAll(["gi", "\t"]).tracked).toBe(false)
  })
  it("reverse-search (Ctrl+R) marks untracked", () => {
    expect(feedAll(["x", "\x12"]).tracked).toBe(false)
  })
  it("bracketed-paste / unknown ESC marks untracked", () => {
    expect(feedAll(["\x1b[200~ls\x1b[201~"]).tracked).toBe(false)
  })
  it("stays untracked across later edits until a reset", () => {
    let s = feedAll(["l", "s", "\x1b[A"]) // untracked
    s = feedInput(s, "x") // still untracked
    expect(s.tracked).toBe(false)
    s = feedInput(s, "\r") // submit re-tracks
    expect(s.tracked).toBe(true)
  })
  it("Ctrl+L (clear screen) leaves the line untouched", () => {
    let s = feedAll(["l", "s"])
    const before = { ...s }
    s = feedInput(s, "\x0c")
    expect(s).toEqual(before)
  })
  it("empty chunk is a no-op", () => {
    const s = feedInput(resetLine(), "")
    expect(s).toEqual(resetLine())
  })
})

describe("isSuggestible", () => {
  it("is true for a non-empty tracked line with cursor at end", () => {
    expect(isSuggestible({ text: "git st", cursor: 6, tracked: true })).toBe(true)
  })
  it("is false when the cursor is not at the end", () => {
    expect(isSuggestible({ text: "git st", cursor: 3, tracked: true })).toBe(false)
  })
  it("is false when untracked", () => {
    expect(isSuggestible({ text: "git", cursor: 3, tracked: false })).toBe(false)
  })
  it("is false for blank input", () => {
    expect(isSuggestible({ text: "   ", cursor: 3, tracked: true })).toBe(false)
    expect(isSuggestible(resetLine())).toBe(false)
  })
})
