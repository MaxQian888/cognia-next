import { SNIPPET_CONTEXT_CHARS, SNIPPET_MAX_CHARS, ELLIPSIS, buildSnippet } from "./snippet"

/** The characters `positions` actually marks, so tests assert intent not arithmetic. */
function marked(text: string, positions: number[]): string {
  return positions
    .slice()
    .sort((a, b) => a - b)
    .map((p) => text[p])
    .join("")
}

describe("buildSnippet", () => {
  it("returns an empty snippet for empty text", () => {
    expect(buildSnippet("", "needle")).toEqual({ text: "", positions: [] })
  })

  it("returns a plain head preview when the needle is blank", () => {
    const result = buildSnippet("some body text", "")
    expect(result.text).toBe("some body text")
    expect(result.positions).toEqual([])
  })

  it("returns a plain head preview when the needle is absent", () => {
    const result = buildSnippet("some body text", "missing")
    expect(result.text).toBe("some body text")
    expect(result.positions).toEqual([])
  })

  it("truncates the head preview of a long non-matching text", () => {
    const result = buildSnippet("a".repeat(SNIPPET_MAX_CHARS + 100), "missing")
    expect(result.text).toBe("a".repeat(SNIPPET_MAX_CHARS) + ELLIPSIS)
    expect(result.positions).toEqual([])
  })

  // ---- positions must address the SNIPPET, not the source text ----

  it("marks the needle when it sits at the start of a short text", () => {
    const result = buildSnippet("needle in the text", "needle")
    expect(result.text).toBe("needle in the text")
    expect(marked(result.text, result.positions)).toBe("needle")
    expect(result.positions).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("shifts positions past the leading ellipsis when the window is clipped", () => {
    const prefix = "x".repeat(500)
    const result = buildSnippet(`${prefix}needle${prefix}`, "needle")
    expect(result.text.startsWith(ELLIPSIS)).toBe(true)
    // The whole point: without the shift these indices would land in the padding.
    expect(marked(result.text, result.positions)).toBe("needle")
  })

  it("adds a trailing ellipsis when the window stops short of the end", () => {
    const result = buildSnippet(`needle${"y".repeat(500)}`, "needle")
    expect(result.text.startsWith(ELLIPSIS)).toBe(false)
    expect(result.text.endsWith(ELLIPSIS)).toBe(true)
    expect(marked(result.text, result.positions)).toBe("needle")
  })

  it("omits the trailing ellipsis when the window reaches the end of the text", () => {
    const result = buildSnippet(`${"x".repeat(500)}needle`, "needle")
    expect(result.text.endsWith(ELLIPSIS)).toBe(false)
    expect(marked(result.text, result.positions)).toBe("needle")
  })

  it("keeps the snippet within the character budget", () => {
    const result = buildSnippet(`${"x".repeat(500)}needle${"y".repeat(500)}`, "needle")
    expect(result.text.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS + 2 * ELLIPSIS.length)
  })

  it("keeps every position inside the snippet bounds", () => {
    const result = buildSnippet(`${"x".repeat(500)}needle${"y".repeat(500)}`, "needle")
    for (const p of result.positions) {
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(result.text.length)
    }
  })

  it("leads with roughly SNIPPET_CONTEXT_CHARS of context before the match", () => {
    const result = buildSnippet(`${"x".repeat(500)}needle${"y".repeat(500)}`, "needle")
    const firstMark = Math.min(...result.positions)
    expect(firstMark - ELLIPSIS.length).toBe(SNIPPET_CONTEXT_CHARS)
  })

  // ---- multiple occurrences ----

  it("marks every occurrence that falls inside the window", () => {
    const result = buildSnippet("ab needle cd needle ef", "needle")
    expect(marked(result.text, result.positions)).toBe("needleneedle")
  })

  it("excludes occurrences that fall outside the window", () => {
    const far = `needle${"z".repeat(SNIPPET_MAX_CHARS * 3)}needle`
    const result = buildSnippet(far, "needle")
    expect(marked(result.text, result.positions)).toBe("needle")
  })

  it("marks the visible half of an occurrence straddling the window edge", () => {
    // Window ends mid-needle: only the visible characters may be marked, and
    // they must still be in range.
    const result = buildSnippet(`${"x".repeat(20)}needle`, "needle", {
      maxChars: 22,
      contextChars: 20,
    })
    expect(result.positions.length).toBeGreaterThan(0)
    for (const p of result.positions) expect(p).toBeLessThan(result.text.length)
    expect(new Set(marked(result.text, result.positions))).toEqual(new Set(["n", "e"]))
  })

  it("counts overlapping occurrences the same way message-search does", () => {
    const result = buildSnippet("aaa", "aa")
    // "aa" occurs at 0 and 1; the union of marked chars is the whole string.
    expect(marked(result.text, result.positions)).toBe("aaa")
  })

  // ---- case and script handling ----

  it("matches case-insensitively but preserves the original casing", () => {
    const result = buildSnippet("The useMemo Hook", "usememo")
    expect(result.text).toBe("The useMemo Hook")
    expect(marked(result.text, result.positions)).toBe("useMemo")
  })

  it("matches a CJK needle", () => {
    const result = buildSnippet("把项目进度同步到周报", "项目进度")
    expect(marked(result.text, result.positions)).toBe("项目进度")
  })

  it("matches a needle with surrounding whitespace trimmed", () => {
    const result = buildSnippet("The useMemo Hook", "  useMemo  ")
    expect(marked(result.text, result.positions)).toBe("useMemo")
  })

  it("honors explicit window overrides", () => {
    const result = buildSnippet(`${"x".repeat(100)}needle${"y".repeat(100)}`, "needle", {
      maxChars: 20,
      contextChars: 5,
    })
    expect(result.text.length).toBeLessThanOrEqual(20 + 2 * ELLIPSIS.length)
    expect(marked(result.text, result.positions)).toBe("needle")
  })
})
