import { parseSegments, splitLinkSegments, type InputSegment } from "./parse-segments"

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

/** Shape helper that also renders mention segments (mentions: true mode). */
function richShape(segments: ReturnType<typeof parseSegments>) {
  return segments.map((s) => {
    if (s.kind === "command") return { k: "cmd", name: s.name, raw: s.raw }
    if (s.kind === "mention") {
      return { k: "men", name: s.name, raw: s.raw, start: s.start, end: s.end }
    }
    // `RichSegment` also admits `param`, which `splitParamSegments` produces —
    // never `parseSegments` itself. Named explicitly so this helper fails to
    // compile rather than silently mis-shaping one if that ever changes.
    if (s.kind === "param") {
      return { k: "par", name: s.paramId, raw: s.raw, start: s.start, end: s.end }
    }
    // `link` comes from `splitLinkSegments` (the overlay's view), never from
    // `parseSegments` itself — same contract as `param` above.
    if (s.kind === "link") return { k: "url", raw: s.raw, start: s.start, end: s.end }
    return { k: "txt", value: s.value, start: s.start, end: s.end }
  })
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

  // ── Rule 2b: same-line chaining ────────────────────────────────────────
  // A line that is NOTHING BUT known commands runs all of them. Any ordinary
  // token on the line falls back to rule 2 (first token = command, rest = args).

  it("chains multiple known commands on one line", () => {
    expect(shape(parseSegments("/help /model", isKnown))).toEqual([
      { k: "cmd", name: "help", args: "", raw: "/help", start: 0, end: 5 },
      { k: "txt", value: " ", start: 5, end: 6 },
      { k: "cmd", name: "model", args: "", raw: "/model", start: 6, end: 12 },
    ])
  })

  it("keeps chained segments contiguous across odd spacing", () => {
    const input = "  /help   /model  "
    const segs = parseSegments(input, isKnown)
    let cursor = 0
    for (const s of segs) {
      expect(s.start).toBe(cursor)
      cursor = s.end
    }
    expect(cursor).toBe(input.length)
    expect(segs.filter((s) => s.kind === "command")).toHaveLength(2)
  })

  it("does NOT chain when any token is not a slash command (args win)", () => {
    // The motivating false positive: a path argument must stay an argument.
    expect(shape(parseSegments("/review src/a.ts", isKnown))).toEqual([
      { k: "cmd", name: "review", args: "src/a.ts", raw: "/review src/a.ts", start: 0, end: 16 },
    ])
  })

  it("does NOT chain when a slash token is not a known command", () => {
    expect(shape(parseSegments("/help /nonexistent", isKnown))).toEqual([
      {
        k: "cmd",
        name: "help",
        args: "/nonexistent",
        raw: "/help /nonexistent",
        start: 0,
        end: 18,
      },
    ])
  })

  it("does NOT chain an absolute path argument", () => {
    expect(shape(parseSegments("/review /usr/local", isKnown))).toEqual([
      {
        k: "cmd",
        name: "review",
        args: "/usr/local",
        raw: "/review /usr/local",
        start: 0,
        end: 18,
      },
    ])
  })

  it("leaves a one-token line on the rule-2 path (trailing space stays in raw)", () => {
    // Guard for the `tokens.length >= 2` requirement: the single-command case
    // must keep `end: contentEnd`, not the token end.
    expect(shape(parseSegments("/clear   ", isKnown))).toEqual([
      { k: "cmd", name: "clear", args: "", raw: "/clear   ", start: 0, end: 9 },
    ])
  })

  it("does not treat a lone slash as a chainable token", () => {
    expect(shape(parseSegments("/ /help", isKnown))).toEqual([
      { k: "txt", value: "/ /help", start: 0, end: 7 },
    ])
  })

  it("chains nested command names", () => {
    expect(shape(parseSegments("/foo/bar /help", isKnown))).toEqual([
      { k: "cmd", name: "foo/bar", args: "", raw: "/foo/bar", start: 0, end: 8 },
      { k: "txt", value: " ", start: 8, end: 9 },
      { k: "cmd", name: "help", args: "", raw: "/help", start: 9, end: 14 },
    ])
  })

  it("chains on a later line and keeps CRLF out of raw", () => {
    const input = "intro\r\n/help /clear\r\ntail"
    const segs = parseSegments(input, isKnown)
    const cmds = segs.filter((s) => s.kind === "command")
    expect(cmds.map((c) => (c.kind === "command" ? c.raw : ""))).toEqual(["/help", "/clear"])
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

  it("does NOT emit mention segments by default", () => {
    const out = parseSegments("see @lib/db now", isKnown)
    expect(out.every((s) => s.kind === "text" || s.kind === "command")).toBe(true)
    expect(out).toEqual([{ kind: "text", value: "see @lib/db now", start: 0, end: 15 }])
  })
})

describe("parseSegments with mentions enabled", () => {
  it("splits an @mention out of surrounding text", () => {
    const out = richShape(parseSegments("see @lib/db now", isKnown, { mentions: true }))
    expect(out).toEqual([
      { k: "txt", value: "see ", start: 0, end: 4 },
      { k: "men", name: "lib/db", raw: "@lib/db", start: 4, end: 11 },
      { k: "txt", value: " now", start: 11, end: 15 },
    ])
  })

  it("recognises a mention at the very start", () => {
    const out = richShape(parseSegments("@bob hi", isKnown, { mentions: true }))
    expect(out).toEqual([
      { k: "men", name: "bob", raw: "@bob", start: 0, end: 4 },
      { k: "txt", value: " hi", start: 4, end: 7 },
    ])
  })

  it("does NOT treat an email or path-@ as a mention", () => {
    const out = richShape(parseSegments("mail user@host and a/@b", isKnown, { mentions: true }))
    expect(out.some((s) => s.k === "men")).toBe(false)
    expect(out).toEqual([{ k: "txt", value: "mail user@host and a/@b", start: 0, end: 23 }])
  })

  it("ignores a lone @ (no token)", () => {
    const out = richShape(parseSegments("a @ b", isKnown, { mentions: true }))
    expect(out.some((s) => s.k === "men")).toBe(false)
  })

  it("interleaves command + mention + prose, staying contiguous", () => {
    const input = "/review auth\nplease ping @alice and @bob"
    const segs = parseSegments(input, isKnown, { mentions: true })
    const mentions = segs
      .filter((s) => s.kind === "mention")
      .map((s) => s.kind === "mention" && s.name)
    expect(mentions).toEqual(["alice", "bob"])
    // contiguity preserved across the split
    let cursor = 0
    for (const s of segs) {
      expect(s.start).toBe(cursor)
      cursor = s.end
    }
    expect(cursor).toBe(input.length)
  })

  it("leaves mention-free text as a single segment", () => {
    const out = richShape(parseSegments("just words here", isKnown, { mentions: true }))
    expect(out).toEqual([{ k: "txt", value: "just words here", start: 0, end: 15 }])
  })
})

describe("parseSegments — links are inert (rule 2c)", () => {
  it("runs a command typed after a pasted link, keeping the URL as text", () => {
    const value = "https://github.com/svenstaro/genact /clear"
    expect(shape(parseSegments(value, isKnown))).toEqual([
      { k: "txt", value: "https://github.com/svenstaro/genact ", start: 0, end: 36 },
      { k: "cmd", name: "clear", args: "", raw: "/clear", start: 36, end: 42 },
    ])
  })

  it("keeps a link between two chained commands", () => {
    const value = "/help https://x.dev/a /clear"
    const out = shape(parseSegments(value, isKnown))
    expect(out.filter((s) => s.k === "cmd").map((s) => s.raw)).toEqual(["/help", "/clear"])
    // Contiguous and complete — the overlay paints by index.
    expect(out.map((s) => value.slice(s.start, s.end)).join("")).toBe(value)
  })

  it("still refuses a line whose non-link token is not a command", () => {
    const value = "https://x.dev/a /usr/local"
    expect(shape(parseSegments(value, isKnown))).toEqual([
      { k: "txt", value, start: 0, end: value.length },
    ])
  })

  it("keeps a URL that a lone command was GIVEN as its argument", () => {
    // A link after the only command is that command's argument, not inert
    // context — treating it as a chain member emitted `args: ""` and dropped
    // the URL into the prompt as prose.
    const value = "/review https://x.dev/a"
    expect(shape(parseSegments(value, isKnown))).toEqual([
      {
        k: "cmd",
        name: "review",
        args: "https://x.dev/a",
        raw: value,
        start: 0,
        end: value.length,
      },
    ])
  })

  it("keeps a folded label a lone command was given as its argument", () => {
    const value = "/review svenstaro/genact"
    const isFolded = (token: string) => token === "svenstaro/genact"
    expect(shape(parseSegments(value, isKnown, { isLinkToken: isFolded }))).toEqual([
      {
        k: "cmd",
        name: "review",
        args: "svenstaro/genact",
        raw: value,
        start: 0,
        end: value.length,
      },
    ])
  })

  it("leaves a lone link as plain text", () => {
    const value = "https://x.dev/a"
    expect(shape(parseSegments(value, isKnown))).toEqual([
      { k: "txt", value, start: 0, end: value.length },
    ])
  })

  it("leaves prose that merely contains a link and a slash alone", () => {
    const value = "look at https://x.dev/a /clear"
    expect(shape(parseSegments(value, isKnown))).toEqual([
      { k: "txt", value, start: 0, end: value.length },
    ])
  })
})

describe("splitLinkSegments", () => {
  it("splits URLs out of text while keeping the list contiguous", () => {
    const value = "see https://x.dev/a now"
    const out = richShape(splitLinkSegments(parseSegments(value, isKnown, { mentions: true })))
    expect(out).toEqual([
      { k: "txt", value: "see ", start: 0, end: 4 },
      { k: "url", raw: "https://x.dev/a", start: 4, end: 19 },
      { k: "txt", value: " now", start: 19, end: 23 },
    ])
  })

  it("passes command segments through untouched", () => {
    // A lone command holding a URL is ONE command segment (the URL is its
    // argument, rule 1) — and a command segment is never split, so the whole
    // line survives as the single `cmd` the submit path needs.
    const value = "/clear https://x.dev/a"
    const out = richShape(splitLinkSegments(parseSegments(value, isKnown, { mentions: true })))
    expect(out).toEqual([{ k: "cmd", name: "clear", raw: value }])
    // …and the URL is still the command's argument, not a demoted text run.
    expect(shape(parseSegments(value, isKnown))).toEqual([
      { k: "cmd", name: "clear", args: "https://x.dev/a", raw: value, start: 0, end: value.length },
    ])
  })

  it("still splits the link out of a real chain's text run", () => {
    const value = "/help https://x.dev/a /clear"
    const out = richShape(splitLinkSegments(parseSegments(value, isKnown, { mentions: true })))
    expect(out.map((s) => s.k)).toEqual(["cmd", "txt", "url", "txt", "cmd"])
  })

  it("returns the original segment when a text run has no link", () => {
    const segments = parseSegments("plain words", isKnown, { mentions: true })
    expect(splitLinkSegments(segments)).toEqual(segments)
  })
})

describe("splitLinkSegments — folded links", () => {
  it("splits a caller-supplied span that has no scheme to recognise", () => {
    const value = "see a/b now"
    const out = richShape(
      splitLinkSegments(parseSegments(value, isKnown, { mentions: true }), [
        { raw: "a/b", start: 4, end: 7 },
      ])
    )
    expect(out).toEqual([
      { k: "txt", value: "see ", start: 0, end: 4 },
      { k: "url", raw: "a/b", start: 4, end: 7 },
      { k: "txt", value: " now", start: 7, end: 11 },
    ])
  })

  it("ignores a supplied span that overlaps a raw URL it already found", () => {
    const value = "https://x.dev/a"
    const out = richShape(
      splitLinkSegments(parseSegments(value, isKnown, { mentions: true }), [
        { raw: "x.dev", start: 8, end: 13 },
      ])
    )
    expect(out).toEqual([{ k: "url", raw: "https://x.dev/a", start: 0, end: 15 }])
  })
})

describe("parseSegments — a folded link is inert too", () => {
  const isFolded = (token: string) => token === "svenstaro/genact"

  it("runs the command beside a folded link", () => {
    const value = "svenstaro/genact /clear"
    const out = shape(parseSegments(value, isKnown, { isLinkToken: isFolded }))
    expect(out).toEqual([
      { k: "txt", value: "svenstaro/genact ", start: 0, end: 17 },
      { k: "cmd", name: "clear", args: "", raw: "/clear", start: 17, end: 23 },
    ])
  })

  it("still refuses an ordinary word in the same position", () => {
    const value = "whatever /clear"
    expect(shape(parseSegments(value, isKnown, { isLinkToken: isFolded }))).toEqual([
      { k: "txt", value, start: 0, end: value.length },
    ])
  })
})
