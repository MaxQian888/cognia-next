import {
  isDeliberateSelection,
  quoteSelection,
  selectionTitleFor,
  SELECTION_TITLE_MAX,
} from "./selection-text"

describe("isDeliberateSelection", () => {
  it("accepts three characters of spaced script and refuses two", () => {
    expect(isDeliberateSelection("abc")).toBe(true)
    expect(isDeliberateSelection("ok")).toBe(false)
  })

  it("ignores surrounding whitespace when counting", () => {
    expect(isDeliberateSelection("  ok \n")).toBe(false)
  })

  // The three-character floor refused the everyday two-character words of
  // Chinese, Japanese and Korean.
  it.each([["变量"], ["関数"], ["함수"], ["カナ"]])("accepts the two-character word %s", (word) => {
    expect(isDeliberateSelection(word)).toBe(true)
  })

  it("still refuses a single dense-script character", () => {
    expect(isDeliberateSelection("变")).toBe(false)
  })
})

describe("selectionTitleFor", () => {
  it("uses a short selection verbatim, collapsing whitespace", () => {
    expect(selectionTitleFor("  check   the\nversions ")).toBe("check the versions")
  })

  it("elides a long selection on a word boundary", () => {
    const title = selectionTitleFor("a".repeat(10) + " " + "b".repeat(60))
    expect(title.endsWith("…")).toBe(true)
    expect(title.length).toBeLessThanOrEqual(SELECTION_TITLE_MAX + 1)
  })

  it("hard-cuts a single unbroken run rather than returning nothing", () => {
    expect(selectionTitleFor("x".repeat(200))).toBe("x".repeat(SELECTION_TITLE_MAX) + "…")
  })

  it("takes a custom limit", () => {
    expect(selectionTitleFor("alpha beta gamma", 12)).toBe("alpha beta…")
  })
})

describe("quoteSelection", () => {
  it("quotes every line, keeping blank lines inside the quote", () => {
    expect(quoteSelection("first\n\nsecond\n")).toBe("> first\n>\n> second")
  })
})
