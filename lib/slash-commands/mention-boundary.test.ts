import { findTokenEnd, isMentionStart, isMentionWhitespace } from "./mention-boundary"

describe("isMentionWhitespace", () => {
  it("matches spaces, tabs and newlines", () => {
    expect(isMentionWhitespace(" ")).toBe(true)
    expect(isMentionWhitespace("\n")).toBe(true)
    expect(isMentionWhitespace("\t")).toBe(true)
  })
  it("rejects non-whitespace", () => {
    expect(isMentionWhitespace("a")).toBe(false)
  })
})

describe("isMentionStart", () => {
  it("matches an @ at the start of the string", () => {
    expect(isMentionStart("@bob", 0)).toBe(true)
  })

  it("matches an @ preceded by whitespace", () => {
    expect(isMentionStart("hi @bob", 3)).toBe(true)
    expect(isMentionStart("line\n@bob", 5)).toBe(true)
  })

  it("rejects an @ preceded by a non-whitespace char (email / path)", () => {
    expect(isMentionStart("user@host", 4)).toBe(false)
    expect(isMentionStart("path/@thing", 5)).toBe(false)
  })

  it("rejects a non-@ index", () => {
    expect(isMentionStart("@bob", 1)).toBe(false)
  })
})

describe("findTokenEnd", () => {
  it("returns the index of the first whitespace after start", () => {
    expect(findTokenEnd("git/commit foo", 0, 14)).toBe(10) // space at 10
  })

  it("returns hardEnd when there is no whitespace in range", () => {
    expect(findTokenEnd("git/commit", 0, 10)).toBe(10)
  })

  it("respects the hardEnd bound", () => {
    expect(findTokenEnd("ab cd", 0, 2)).toBe(2) // stops before the space at 2
  })

  it("stops at a newline as well as a space", () => {
    expect(findTokenEnd("ab\ncd", 0, 5)).toBe(2)
  })
})
