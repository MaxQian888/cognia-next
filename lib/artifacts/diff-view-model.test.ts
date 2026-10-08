import type { DiffLine } from "@/types"
import type { DiffRow } from "./diff"
import {
  MAX_FIND_MATCHES,
  findMatches,
  intralineRanges,
  pairChangedLines,
  paintRuns,
  toSplitRows,
  type DiffEntry,
} from "./diff-view-model"

const u = (content: string, n: number): DiffLine => ({
  type: "unchanged",
  content,
  oldLineNum: n,
  newLineNum: n,
})
const r = (content: string, n: number): DiffLine => ({ type: "removed", content, oldLineNum: n })
const a = (content: string, n: number): DiffLine => ({ type: "added", content, newLineNum: n })

function rowsOf(lines: DiffLine[]): DiffRow[] {
  return lines.map((line, index) => ({ kind: "line", line, index }))
}

function entries(lines: DiffLine[]): DiffEntry[] {
  return lines.map((line, index) => ({ line, index }))
}

describe("toSplitRows", () => {
  it("puts unchanged lines on both sides and zips a change block", () => {
    const lines = [u("k", 1), r("x1", 2), r("x2", 3), a("y1", 2), u("t", 4)]
    const split = toSplitRows(rowsOf(lines))
    expect(split).toHaveLength(4)
    expect(split[0]).toEqual({
      kind: "pair",
      left: { line: lines[0], index: 0 },
      right: { line: lines[0], index: 0 },
    })
    expect(split[1]).toEqual({
      kind: "pair",
      left: { line: lines[1], index: 1 },
      right: { line: lines[3], index: 3 },
    })
    expect(split[2]).toEqual({ kind: "pair", left: { line: lines[2], index: 2 }, right: null })
  })

  it("keeps a lone addition on the right and passes gaps and headers through", () => {
    const rows: DiffRow[] = [
      { kind: "header", key: "h", text: "@@" },
      { kind: "gap", start: 0, count: 5 },
      { kind: "line", index: 5, line: a("new", 6) },
    ]
    const split = toSplitRows(rows)
    expect(split[0]).toEqual(rows[0])
    expect(split[1]).toEqual(rows[1])
    expect(split[2]).toEqual({
      kind: "pair",
      left: null,
      right: { line: rows[2].kind === "line" ? rows[2].line : a("", 0), index: 5 },
    })
  })
})

describe("pairChangedLines", () => {
  it("pairs the k-th removal with the k-th addition, both ways", () => {
    const lines = [r("a", 1), r("b", 2), a("A", 1), u("c", 3), a("lone", 4)]
    const partners = pairChangedLines(entries(lines))
    expect(partners.get(0)).toBe(lines[2])
    expect(partners.get(2)).toBe(lines[0])
    expect(partners.has(1)).toBe(false)
    expect(partners.has(4)).toBe(false)
  })
})

describe("intralineRanges", () => {
  it("emphasises the changed characters of an edited line", () => {
    expect(intralineRanges(r("const a = 1", 1), a("const a = 2", 1))).toEqual([[10, 11]])
    expect(intralineRanges(a("const a = 2", 1), r("const a = 1", 1))).toEqual([[10, 11]])
  })

  it("leaves rewrites, identical lines and unpaired lines plain", () => {
    expect(intralineRanges(r("abcdef", 1), a("uvwxyz", 1))).toBeNull()
    expect(intralineRanges(r("same", 1), a("same", 1))).toBeNull()
    expect(intralineRanges(r("x", 1), undefined)).toBeNull()
    expect(intralineRanges(u("x", 1), a("y", 1))).toBeNull()
  })
})

describe("findMatches", () => {
  const lines = [u("Foo foo", 1), u("bar", 2), a("FOO", 3)]
  const source = entries(lines)
  const lowered = lines.map((l) => l.content.toLowerCase())

  it("finds every case-insensitive hit in order", () => {
    expect(findMatches(source, lowered, "foo")).toEqual({
      matches: [
        { index: 0, start: 0 },
        { index: 0, start: 4 },
        { index: 2, start: 0 },
      ],
      capped: false,
    })
  })

  it("is empty for an empty query", () => {
    expect(findMatches(source, lowered, "").matches).toEqual([])
  })

  it("stops at the cap", () => {
    const many = entries([u("x".repeat(MAX_FIND_MATCHES + 5), 1)])
    const result = findMatches(many, [many[0].line.content], "x")
    expect(result.capped).toBe(true)
    expect(result.matches).toHaveLength(MAX_FIND_MATCHES)
  })
})

describe("paintRuns", () => {
  it("cuts at change and hit boundaries and marks the current hit", () => {
    const runs = paintRuns("abcdef", [[1, 3]], [2, 4], 2, 4)
    expect(runs).toEqual([
      { text: "a", changed: false, match: false, current: false },
      { text: "b", changed: true, match: false, current: false },
      { text: "c", changed: true, match: true, current: false },
      { text: "d", changed: false, match: true, current: false },
      { text: "ef", changed: false, match: true, current: true },
    ])
  })

  it("returns the whole line as one plain run when nothing applies", () => {
    expect(paintRuns("abc", null, undefined, 0, null)).toEqual([
      { text: "abc", changed: false, match: false, current: false },
    ])
  })
})
