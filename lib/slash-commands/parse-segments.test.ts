import { parseSegments, type InputSegment } from "./parse-segments"

// A small set of "known" commands for the injected predicate.
const KNOWN = new Set(["help", "model", "review", "clear", "foo/bar"])
const isKnown = (name: string) => KNOWN.has(name)

/** Convenience: collapse a segment list to a compact, assertable shape. */
function shape(segments: InputSegment[]) {
  return segments.map((s) =>
    s.kind === "command"
      ? { k: "cmd", name: s.name, args: s.args, raw: s.raw, start: s.start, end: s.end }
      : { k: "txt", value: s.value, start: s.start, end: s.end }
  )
}

describe("parseSegments", () => {
  it("returns an empty list for empty input", () => {
    expect(parseSegments("", isKnown)).toEqual([])
  })

  it("treats whitespace-only input as a single text segment", () => {
    expect(shape(parseSegments("   ", isKnown))).toEqual([
      { k: "txt", value: "   ", start: 0, end: 3 },
    ])
  })

  it("parses a single command with no args (degenerate single-command case)", () => {
    expect(shape(parseSegments("/clear", isKnown))).toEqual([
      { k: "cmd", name: "clear", args: "", raw: "/clear", start: 0, end: 6 },
    ])
  })

  it("parses a single command with args to end of line", () => {
    expect(shape(parseSegments("/review auth flow", isKnown))).toEqual([
      { k: "cmd", name: "review", args: "auth flow", raw: "/review auth flow", start: 0, end: 17 },
    ])
  })

  it("keeps trailing prose after a command as text", () => {
    const out = shape(parseSegments("/help\nplease explain", isKnown))
    expect(out).toEqual([
      { k: "cmd", name: "help", args: "", raw: "/help", start: 0, end: 5 },
      { k: "txt", value: "\nplease explain", start: 5, end: 20 },
    ])
  })

  it("parses multiple line-start commands plus trailing prose", () => {
    const input = "/model opus\n/review auth flow\nplease also check errors"
    const out = shape(parseSegments(input, isKnown))
    // Segments are contiguous, so the newline between the two commands is its
    // own text segment — assert on the filtered command list, not raw indices.
    const cmds = out.filter((s) => s.k === "cmd")
    expect(cmds).toHaveLength(2)
    expect(cmds[0]).toMatchObject({ k: "cmd", name: "model", args: "opus" })
    expect(cmds[1]).toMatchObject({ k: "cmd", name: "review", args: "auth flow" })
    expect(out.some((s) => s.k === "txt" && s.value?.includes("please also check errors"))).toBe(
      true
    )
  })

  it("does NOT treat a mid-line slash as a command (urls / paths / math)", () => {
    const out = shape(parseSegments("see a/b and http://x.com", isKnown))
    expect(out).toEqual([{ k: "txt", value: "see a/b and http://x.com", start: 0, end: 24 }])
  })

  it("treats an unknown line-start slash word as text", () => {
    const out = shape(parseSegments("/unknownword stuff", isKnown))
    expect(out).toEqual([{ k: "txt", value: "/unknownword stuff", start: 0, end: 18 }])
  })

  it("recognises a command after leading whitespace on its line", () => {
    const out = shape(parseSegments("  /help", isKnown))
    expect(out).toEqual([
      { k: "txt", value: "  ", start: 0, end: 2 },
      { k: "cmd", name: "help", args: "", raw: "/help", start: 2, end: 7 },
    ])
  })

  it("handles CRLF line endings", () => {
    const out = shape(parseSegments("/help\r\n/model opus", isKnown))
    expect(out[0]).toMatchObject({ k: "cmd", name: "help", args: "" })
    expect(out.some((s) => s.k === "cmd" && s.name === "model" && s.args === "opus")).toBe(true)
  })

  it("supports nested command names containing a slash", () => {
    const out = shape(parseSegments("/foo/bar baz", isKnown))
    expect(out).toEqual([
      { k: "cmd", name: "foo/bar", args: "baz", raw: "/foo/bar baz", start: 0, end: 12 },
    ])
  })

  it("coalesces consecutive non-command lines into one text segment", () => {
    const out = shape(parseSegments("line one\nline two", isKnown))
    expect(out).toEqual([{ k: "txt", value: "line one\nline two", start: 0, end: 17 }])
  })

  it("produces contiguous segments covering the whole input", () => {
    const input = "intro\n/help\nmid\n/model opus\nend"
    const segs = parseSegments(input, isKnown)
    // contiguity: each segment starts where the previous ended; full coverage.
    let cursor = 0
    for (const s of segs) {
      expect(s.start).toBe(cursor)
      cursor = s.end
    }
    expect(cursor).toBe(input.length)
  })

  it("preserves positional arg spacing inside args", () => {
    const out = shape(parseSegments("/model   opus   fast", isKnown))
    expect(out[0]).toMatchObject({ k: "cmd", name: "model", args: "opus   fast" })
  })
})
