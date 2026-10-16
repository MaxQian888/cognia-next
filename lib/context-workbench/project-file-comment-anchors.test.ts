import { sha256String } from "@/lib/ocr/hash"
import {
  createProjectFileAnchor,
  resolveProjectFileAnchor,
  QUOTE_LIMIT,
  CONTEXT_LIMIT,
  FUZZY_LINE_WINDOW,
  FUZZY_MIN_SIMILARITY,
  FUZZY_MIN_LEAD,
} from "./project-file-comment-anchors"

describe("project-file comment anchors", () => {
  it("pins the quote, context and fuzzy bounds", () => {
    expect([
      QUOTE_LIMIT,
      CONTEXT_LIMIT,
      FUZZY_LINE_WINDOW,
      FUZZY_MIN_SIMILARITY,
      FUZZY_MIN_LEAD,
    ]).toEqual([8192, 128, 200, 0.9, 0.1])
  })

  it("captures a capped quote and the full UTF-8 hash", async () => {
    const quote = "🙂".repeat(5000)
    const anchor = await createProjectFileAnchor(
      "p".repeat(150) + quote + "s".repeat(150),
      150,
      10150
    )
    expect(anchor).toMatchObject({
      anchorVersion: 1,
      quoteLength: 10000,
      quoteComplete: false,
      quotedText: quote.slice(0, 8192),
      prefixContext: "p".repeat(128),
      suffixContext: "s".repeat(128),
      quoteSha256: await sha256String(quote),
    })
    await expect(createProjectFileAnchor("x", -1, 2)).rejects.toThrow(RangeError)
  })

  it("resolves identical content regardless of revision changes", async () => {
    const anchor = await createProjectFileAnchor("before\ntarget\nafter", 7, 13)
    expect(
      await resolveProjectFileAnchor(anchor, "before\ntarget\nafter", {
        currentRevision: "saved-again",
      })
    ).toMatchObject({ status: "resolved", start: 7, end: 13, method: "identical" })
  })

  it.each([
    ["new\nbefore\ntarget\nafter", 11, 17],
    ["before\ntarNEWget\nafter", 7, 16],
    ["before\ntarget\nafter\nnew", 7, 13],
    ["before\nNEWtarget\nafter", 10, 16],
    ["before\ntargetNEW\nafter", 7, 13],
  ])("maps insertions with base-text diff: %s", async (current, start, end) => {
    const base = "before\ntarget\nafter"
    const anchor = await createProjectFileAnchor(base, 7, 13)
    expect(await resolveProjectFileAnchor(anchor, current, { baseText: base })).toMatchObject({
      start,
      end,
      method: "diff",
      status: start === 7 && end === 13 ? "resolved" : "moved",
    })
  })

  it("maps changed boundary lines of a multiline selection", async () => {
    const base = "one target\nmiddle\nlast end"
    const anchor = await createProjectFileAnchor(base, 4, 22)
    const current = "prefix one target\nmiddle\nlast suffix end"
    expect(await resolveProjectFileAnchor(anchor, current, { baseText: base })).toMatchObject({
      start: 11,
      end: 29,
      method: "diff",
    })
  })

  it("does not attach deleted text to its replacement", async () => {
    const base = "before\ntarget\nafter"
    const anchor = await createProjectFileAnchor(base, 7, 13)
    expect(
      await resolveProjectFileAnchor(anchor, "before\n\nafter", { baseText: base })
    ).toMatchObject({ status: "orphaned", method: "none" })
  })

  it("finds an exact quote without the base and disambiguates by context before distance", async () => {
    const anchor = await createProjectFileAnchor("left target right", 5, 11)
    const current = "bad target wrong\nleft target right"
    expect(await resolveProjectFileAnchor(anchor, current)).toMatchObject({
      start: 22,
      end: 28,
      method: "quote-exact",
      status: "moved",
    })
    expect(
      await resolveProjectFileAnchor(
        { ...anchor, prefixContext: "", suffixContext: "", start: 4, end: 10 },
        "targetxx target"
      )
    ).toMatchObject({ start: 0, method: "quote-exact" })
  })

  it("rejects equally good, equidistant duplicates", async () => {
    const anchor = await createProjectFileAnchor("12345target", 5, 11)
    expect(
      await resolveProjectFileAnchor(
        { ...anchor, prefixContext: "", suffixContext: "" },
        "target----target"
      )
    ).toMatchObject({ status: "orphaned" })
  })

  it("accepts small substitutions, insertions and deletions through fuzzy search", async () => {
    const quote = "abcdefghijklmnopqrst"
    const anchor = await createProjectFileAnchor(quote, 0, quote.length)
    for (const text of [
      "abcdefghijXlmnopqrst",
      "abcdefghijXklmnopqrst",
      "abcdefghijlmnopqrst",
      "Xbcdefghijklmnopqrst",
      "abcdefghijklmnopqrsX",
    ]) {
      expect(await resolveProjectFileAnchor(anchor, "intro\n" + text + "\nend")).toMatchObject({
        start: 6,
        end: 6 + text.length,
        method: "quote-fuzzy",
        status: "moved",
      })
    }
  })

  it("rejects low similarity and close fuzzy competitors", async () => {
    const anchor = await createProjectFileAnchor("abcdefghijklmnopqrst", 0, 20)
    expect(await resolveProjectFileAnchor(anchor, "abcXXXXXXXklmnopqrst")).toMatchObject({
      status: "orphaned",
    })
    expect(
      await resolveProjectFileAnchor(anchor, "abcdefghijXlmnopqrst\nabcdefghijYlmnopqrst")
    ).toMatchObject({ status: "orphaned" })
  })

  it("keeps fuzzy search within 200 lines", async () => {
    const anchor = await createProjectFileAnchor("abcdefghijklmnopqrst", 0, 20)
    expect(
      await resolveProjectFileAnchor(anchor, "x\n".repeat(201) + "abcdefghijXlmnopqrst")
    ).toMatchObject({ status: "orphaned" })
  })

  it("verifies the entire truncated quote, not just its visible prefix", async () => {
    const quote = "x".repeat(8192) + "tail"
    const anchor = await createProjectFileAnchor(quote, 0, quote.length)
    expect(await resolveProjectFileAnchor(anchor, "intro\n" + quote)).toMatchObject({
      status: "moved",
      start: 6,
      end: 8202,
      method: "quote-exact",
    })
    for (const altered of ["intro\n" + "x".repeat(8192) + "fail", "intro\n" + "x".repeat(8192)]) {
      expect(await resolveProjectFileAnchor(anchor, altered)).toMatchObject({ status: "orphaned" })
    }
    expect(
      await resolveProjectFileAnchor({ ...anchor, quoteSha256: undefined }, "intro\n" + quote)
    ).toMatchObject({ status: "orphaned" })
    expect(
      await resolveProjectFileAnchor(anchor, "intro\n" + quote.replace("tail", "fail"), {
        baseText: quote,
      })
    ).toMatchObject({ status: "orphaned" })
  })

  it("uses UTF-16 offsets with emoji and CRLF", async () => {
    const base = "🙂\r\n🎉target\r\n"
    const anchor = await createProjectFileAnchor(base, 4, 12)
    expect(anchor.lineRange).toEqual({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 9 })
    expect(
      await resolveProjectFileAnchor(anchor, "✨\r\n" + base, { baseText: base })
    ).toMatchObject({
      start: 7,
      end: 15,
      lineRange: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 9 },
    })
  })

  it("handles empty files, empty selections, and EOF", async () => {
    const empty = await createProjectFileAnchor("", 0, 0)
    expect(await resolveProjectFileAnchor(empty, "")).toMatchObject({
      status: "resolved",
      start: 0,
      end: 0,
    })
    expect(await resolveProjectFileAnchor(empty, "new", { baseText: "" })).toMatchObject({
      start: 3,
      end: 3,
      method: "diff",
    })
    expect(await resolveProjectFileAnchor(empty, "new")).toMatchObject({ status: "orphaned" })
    const eof = await createProjectFileAnchor("abc", 3, 3)
    expect(await resolveProjectFileAnchor(eof, "intro\nabc")).toMatchObject({ start: 9, end: 9 })
    const point = await createProjectFileAnchor("left right", 5, 5)
    expect(await resolveProjectFileAnchor(point, "intro left right")).toMatchObject({
      start: 11,
      end: 11,
    })
  })

  it("never uses a base text from a different hash domain", async () => {
    const anchor = await createProjectFileAnchor("before target", 7, 13)
    expect(
      await resolveProjectFileAnchor(anchor, "nothing", { baseText: "wrong target" })
    ).toMatchObject({ status: "orphaned" })
  })

  it("keeps legacy revision staleness and never guesses", async () => {
    const anchor = { kind: "text-range" as const, start: 0, end: 3, revision: "r1" }
    expect(await resolveProjectFileAnchor(anchor, "abc", { currentRevision: "r1" })).toMatchObject({
      status: "resolved",
    })
    expect(
      await resolveProjectFileAnchor(anchor, "abc", { currentRevision: "r2", baseText: "abc" })
    ).toMatchObject({ status: "legacy-stale", method: "none" })
    expect(
      await resolveProjectFileAnchor({ ...anchor, quotedText: "abc" }, "new abc", {
        currentRevision: "r2",
      })
    ).toMatchObject({ status: "moved", start: 4, end: 7 })
  })
})

it("fuzzily matches a complete 8 Ki quote without treating it as truncated", async () => {
  let state = 42
  const quote = Array.from({ length: QUOTE_LIMIT }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return String.fromCharCode(97 + ((state >>> 16) % 26))
  }).join("")
  const anchor = await createProjectFileAnchor(quote, 0, quote.length)
  const edited = quote.slice(0, 4096) + "!" + quote.slice(4097)
  expect(await resolveProjectFileAnchor(anchor, "intro\n" + edited)).toMatchObject({
    status: "moved",
    method: "quote-fuzzy",
    start: 6,
    end: 6 + QUOTE_LIMIT,
  })
})

it("rejects equally strong overlapping fuzzy occurrences", async () => {
  const anchor = await createProjectFileAnchor("aaaaabaaaaa", 0, 11)
  expect(await resolveProjectFileAnchor(anchor, "aaaaaaaaaaaa")).toMatchObject({
    status: "orphaned",
  })
})

it("does not split surrogate pairs during fuzzy resolution", async () => {
  const quote = "🙂abcdefghijklmnopqr"
  const anchor = await createProjectFileAnchor(quote, 0, quote.length)
  expect(await resolveProjectFileAnchor(anchor, "intro\n🎉abcdefghijklmnopqr")).toMatchObject({
    method: "quote-fuzzy",
    start: 6,
    end: 26,
  })
})

it("accepts fuzzy substitutions at selection boundaries", async () => {
  const quote = "abcdefghijklmnopqrst"
  const anchor = await createProjectFileAnchor(quote, 0, quote.length)
  for (const current of ["Xbcdefghijklmnopqrst", "abcdefghijklmnopqrsX"]) {
    expect(await resolveProjectFileAnchor(anchor, "intro\n" + current + "\nend")).toMatchObject({
      method: "quote-fuzzy",
      start: 6,
      end: 26,
    })
  }
})
