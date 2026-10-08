import type { DiffLine } from "@/types"
import {
  collapseDiffContext,
  computeDiff,
  computeDiffStats,
  diffIndexForLine,
  newLineForOldLine,
} from "./diff"

/** Reference LCS length (quadratic; small inputs only). */
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

function sides(diff: DiffLine[]) {
  return {
    old: diff.filter((l) => l.type !== "added").map((l) => l.content),
    next: diff.filter((l) => l.type !== "removed").map((l) => l.content),
  }
}

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe("computeDiff", () => {
  it("marks identical input as all unchanged", () => {
    const diff = computeDiff("a\nb\nc", "a\nb\nc")
    expect(diff.every((l) => l.type === "unchanged")).toBe(true)
    expect(diff).toHaveLength(3)
    expect(diff[0]).toMatchObject({ content: "a", oldLineNum: 1, newLineNum: 1 })
  })

  it("detects pure additions", () => {
    const diff = computeDiff("a\nb", "a\nb\nc\nd")
    const added = diff.filter((l) => l.type === "added").map((l) => l.content)
    expect(added).toEqual(["c", "d"])
    expect(diff.find((l) => l.content === "c")).toMatchObject({ newLineNum: 3 })
  })

  it("detects pure removals", () => {
    const diff = computeDiff("a\nb\nc", "a")
    const removed = diff.filter((l) => l.type === "removed").map((l) => l.content)
    expect(removed).toEqual(["b", "c"])
    expect(diff.find((l) => l.content === "c")).toMatchObject({ oldLineNum: 3 })
  })

  it("captures replacements as remove-then-add pairs", () => {
    const diff = computeDiff("a\nb\nc", "a\nB\nc")
    expect(diff.map((l) => `${l.type}:${l.content}`)).toEqual([
      "unchanged:a",
      "removed:b",
      "added:B",
      "unchanged:c",
    ])
  })

  it("keeps every changed region ordered removals first, then additions", () => {
    const diff = computeDiff("x\n1\n2\n3\ny", "x\nA\n2\nB\nC\ny")
    // Any interleaving of - and + inside one region must be normalised.
    let sawAddedInRegion = false
    for (const line of diff) {
      if (line.type === "unchanged") sawAddedInRegion = false
      else if (line.type === "added") sawAddedInRegion = true
      else expect(sawAddedInRegion).toBe(false)
    }
    expect(sides(diff)).toEqual({
      old: ["x", "1", "2", "3", "y"],
      next: ["x", "A", "2", "B", "C", "y"],
    })
  })

  it("aligns large files exactly instead of reporting a full rewrite", () => {
    // The LCS table this replaced gave up above 1,000,000 cells and reported
    // two identical 1,001-line files as entirely removed and re-added.
    const big = Array.from({ length: 1001 }, (_, i) => String(i)).join("\n")
    expect(computeDiff(big, big).every((l) => l.type === "unchanged")).toBe(true)

    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
    const edited = [...lines]
    edited[10_000] = "changed"
    edited.splice(15_000, 0, "inserted")
    const diff = computeDiff(lines.join("\n"), edited.join("\n"))
    expect(computeDiffStats(diff)).toEqual({ added: 2, removed: 1 })
    expect(diff.find((l) => l.type === "added" && l.content === "inserted")).toMatchObject({
      newLineNum: 15_001,
    })
  })

  it("stays within its budget on unrelated inputs, degrading only the unresolved range", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 4000 }, (_, i) => `b${i}`)
    const old = ["head", ...a, "tail"].join("\n")
    const next = ["head", ...b, "tail"].join("\n")
    const started = Date.now()
    const diff = computeDiff(old, next, { budget: 10_000 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(diff[0]).toMatchObject({ type: "unchanged", content: "head" })
    expect(diff.at(-1)).toMatchObject({ type: "unchanged", content: "tail" })
    expect(computeDiffStats(diff)).toEqual({ added: 4000, removed: 4000 })
    expect(sides(diff)).toEqual({ old: old.split("\n"), next: next.split("\n") })
  })

  it("keeps exact alignment outside a range that ran out of budget", () => {
    const shared = Array.from({ length: 50 }, (_, i) => `s${i}`)
    const old = [...shared, "x1", "x2", "x3", ...shared].join("\n")
    const next = [...shared, "y1", "y2", ...shared].join("\n")
    const diff = computeDiff(old, next, { budget: 1 })
    expect(diff.filter((l) => l.type === "unchanged")).toHaveLength(100)
    expect(sides(diff)).toEqual({ old: old.split("\n"), next: next.split("\n") })
  })

  it("is a minimal, faithful edit script on random input", () => {
    const rand = rng(42)
    const alphabet = ["a", "b", "c", "d", "e"]
    for (let round = 0; round < 300; round++) {
      const len = () => Math.floor(rand() * 25)
      const pick = () => alphabet[Math.floor(rand() * alphabet.length)]
      const a = Array.from({ length: len() }, pick)
      const b = Array.from({ length: len() }, pick)
      const diff = computeDiff(a.join("\n"), b.join("\n"))
      // An empty text has no lines (see computeDiff).
      const aLines = a.length === 0 ? [] : a.join("\n").split("\n")
      const bLines = b.length === 0 ? [] : b.join("\n").split("\n")
      expect(sides(diff)).toEqual({ old: aLines, next: bLines })
      expect(diff.filter((l) => l.type === "unchanged")).toHaveLength(lcsLength(aLines, bLines))
      // Line numbers are consecutive per side.
      let oldNum = 0
      let newNum = 0
      for (const line of diff) {
        if (line.type !== "added") expect(line.oldLineNum).toBe(++oldNum)
        if (line.type !== "removed") expect(line.newLineNum).toBe(++newNum)
      }
    }
  })

  it("treats an empty text as no lines", () => {
    expect(computeDiff("", "a\nb").map((l) => l.type)).toEqual(["added", "added"])
    expect(computeDiff("a", "").map((l) => l.type)).toEqual(["removed"])
    expect(computeDiff("", "")).toEqual([])
  })

  it("can ignore leading and trailing whitespace, showing the new text", () => {
    const diff = computeDiff("if (x) {\n  a()\n}", "if (x) {\n    a()  \n}\nb()", {
      ignoreTrimWhitespace: true,
    })
    expect(diff.map((l) => `${l.type}:${l.content}`)).toEqual([
      "unchanged:if (x) {",
      "unchanged:    a()  ",
      "unchanged:}",
      "added:b()",
    ])
    expect(computeDiff("  a", "a").map((l) => l.type)).toEqual(["removed", "added"])
  })

  it("treats a trailing newline as a trailing empty line", () => {
    const diff = computeDiff("a\n", "a")
    expect(diff.map((l) => `${l.type}:${l.content}`)).toEqual(["unchanged:a", "removed:"])
  })
})

describe("computeDiffStats", () => {
  it("counts added and removed lines", () => {
    const stats = computeDiffStats(computeDiff("a\nb\nc", "a\nx\ny"))
    expect(stats).toEqual({ added: 2, removed: 2 })
  })

  it("returns 0/0 for unchanged input", () => {
    expect(computeDiffStats(computeDiff("a\nb", "a\nb"))).toEqual({ added: 0, removed: 0 })
  })
})

describe("collapseDiffContext", () => {
  const file = Array.from({ length: 30 }, (_, i) => `l${i}`)
  const edited = [...file]
  edited[15] = "changed"
  const diff = computeDiff(file.join("\n"), edited.join("\n"))

  it("folds long unchanged runs into gaps around each change", () => {
    const rows = collapseDiffContext(diff, 3)
    expect(rows[0]).toEqual({ kind: "gap", start: 0, count: 12 })
    const lines = rows.filter((r) => r.kind === "line")
    // 3 context + removed + added + 3 context
    expect(lines).toHaveLength(8)
    expect(rows.at(-1)).toMatchObject({ kind: "gap", count: 11 })
  })

  it("shows an expanded gap in full", () => {
    const expanded = new Set([0])
    const rows = collapseDiffContext(diff, 3, expanded)
    expect(rows[0]).toMatchObject({ kind: "line", index: 0 })
    expect(rows.filter((r) => r.kind === "gap")).toHaveLength(1)
  })

  it("never folds a single line into a gap", () => {
    const short = computeDiff("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nX\ne\nf\ng\nh")
    expect(collapseDiffContext(short, 3).every((r) => r.kind === "line")).toBe(true)
  })

  it("collapses a diff without changes to one gap", () => {
    expect(collapseDiffContext(computeDiff("a\nb\nc", "a\nb\nc"), 3)).toEqual([
      { kind: "gap", start: 0, count: 3 },
    ])
  })
})

describe("line mapping", () => {
  // old: a b c d      new: a B c X d
  const diff = computeDiff("a\nb\nc\nd", "a\nB\nc\nX\nd")

  it("finds a line's index on either side", () => {
    expect(diff[diffIndexForLine(diff, "old", 2)]).toMatchObject({ type: "removed", content: "b" })
    expect(diff[diffIndexForLine(diff, "new", 4)]).toMatchObject({ type: "added", content: "X" })
    // Past the end clamps to the last line on that side.
    expect(diff[diffIndexForLine(diff, "old", 99)]).toMatchObject({ content: "d" })
    expect(diffIndexForLine([], "old", 1)).toBe(-1)
  })

  it("maps an original-side change start onto the modified side", () => {
    expect(newLineForOldLine(diff, 1)).toBe(1)
    // "b" was replaced; its replacement "B" sits at new line 2.
    expect(newLineForOldLine(diff, 2)).toBe(2)
    expect(newLineForOldLine(diff, 4)).toBe(5)
  })

  it("lands a pure deletion on the line after it", () => {
    const deletion = computeDiff("a\nb\nc", "a\nc")
    expect(newLineForOldLine(deletion, 2)).toBe(2)
    expect(newLineForOldLine([], 3)).toBe(1)
  })
})
