import { createPasteParser } from "./bracketed-paste"

const START = "\x1b[200~"
const END = "\x1b[201~"

describe("bracketed paste parser", () => {
  it("passes plain keystrokes through unchanged", () => {
    const p = createPasteParser()
    expect(p.feed("a")).toEqual({ keys: "a", pastes: [] })
  })
  it("captures a complete paste span as one paste", () => {
    const p = createPasteParser()
    expect(p.feed(`${START}line1\nline2${END}`)).toEqual({ keys: "", pastes: ["line1\nline2"] })
  })
  it("handles a paste split across two chunks", () => {
    const p = createPasteParser()
    expect(p.feed(`${START}hel`)).toEqual({ keys: "", pastes: [] })
    expect(p.feed(`lo${END}`)).toEqual({ keys: "", pastes: ["hello"] })
  })
  it("separates surrounding keystrokes from the paste", () => {
    const p = createPasteParser()
    expect(p.feed(`x${START}p${END}y`)).toEqual({ keys: "xy", pastes: ["p"] })
  })
  it("handles a start marker split across a chunk boundary", () => {
    const p = createPasteParser()
    expect(p.feed("\x1b[20")).toEqual({ keys: "", pastes: [] })
    expect(p.feed(`0~p${END}`)).toEqual({ keys: "", pastes: ["p"] })
  })
  it("handles an end marker split across a chunk boundary", () => {
    const p = createPasteParser()
    expect(p.feed(`${START}hello\x1b[20`)).toEqual({ keys: "", pastes: [] })
    expect(p.feed("1~")).toEqual({ keys: "", pastes: ["hello"] })
  })
  it("captures multiple pastes in one feed", () => {
    const p = createPasteParser()
    expect(p.feed(`${START}a${END}${START}b${END}`)).toEqual({
      keys: "",
      pastes: ["a", "b"],
    })
  })
  it("interleaves keys and multiple pastes in one feed", () => {
    const p = createPasteParser()
    expect(p.feed(`1${START}a${END}2${START}b${END}3`)).toEqual({
      keys: "123",
      pastes: ["a", "b"],
    })
  })
  it("keeps an empty paste as an empty string", () => {
    const p = createPasteParser()
    expect(p.feed(`${START}${END}`)).toEqual({ keys: "", pastes: [""] })
  })
  it("does not treat an ESC that is not a marker prefix as buffered", () => {
    const p = createPasteParser()
    // ESC followed by a non-`[` byte cannot be a paste marker -> flush ESC.
    expect(p.feed("\x1bO")).toEqual({ keys: "\x1bO", pastes: [] })
  })
  it("buffers a lone trailing ESC until the next chunk resolves it", () => {
    const p = createPasteParser()
    expect(p.feed("a\x1b")).toEqual({ keys: "a", pastes: [] })
    expect(p.feed("b")).toEqual({ keys: "\x1bb", pastes: [] })
  })
  it("flushes a partial marker prefix that turns out not to be a marker", () => {
    const p = createPasteParser()
    expect(p.feed("\x1b[2")).toEqual({ keys: "", pastes: [] })
    // `\x1b[2X` diverges from both `\x1b[200~` and `\x1b[201~`.
    expect(p.feed("X")).toEqual({ keys: "\x1b[2X", pastes: [] })
  })
})
