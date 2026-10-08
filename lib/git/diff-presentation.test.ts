import type { GitDiff, GitHunk, GitStatus } from "@/types/git"
import {
  MONACO_DIFF_CHAR_LIMIT,
  MONACO_DIFF_LINE_LIMIT,
  diffPresentation,
  gitHunksToDiffRows,
  hunkIndexAtLine,
  hunkStats,
  orderedReviewFiles,
  resolveReviewSide,
  reviewFileNeighbours,
} from "./diff-presentation"

function hunk(over: Partial<GitHunk> = {}): GitHunk {
  return {
    header: "@@ -1,3 +1,3 @@",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    patch: "",
    lines: [],
    ...over,
  }
}

function diff(over: Partial<GitDiff> = {}): GitDiff {
  return { path: "a.ts", oldContent: "a", newContent: "b", hunks: [], isBinary: false, ...over }
}

function change(path: string, group: "staged" | "changes" | "merge") {
  return { path, origPath: null, status: "modified" as const, staged: group === "staged", group }
}

function status(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    merge: [],
    isRebasing: false,
    isMerging: false,
    ...over,
  }
}

describe("diffPresentation", () => {
  it("uses Monaco for ordinary diffs", () => {
    expect(diffPresentation(diff())).toBe("monaco")
  })

  it("is hunks-only when the host omitted the full texts", () => {
    expect(diffPresentation(diff({ contentOmitted: true, oldContent: "", newContent: "" }))).toBe(
      "hunks-only"
    )
  })

  it("flags large diffs by characters and by lines", () => {
    const long = "x".repeat(MONACO_DIFF_CHAR_LIMIT)
    expect(diffPresentation(diff({ oldContent: long, newContent: "y" }))).toBe("large")
    const many = "\n".repeat(MONACO_DIFF_LINE_LIMIT / 2 + 1)
    expect(diffPresentation(diff({ oldContent: many, newContent: many }))).toBe("large")
  })
})

describe("gitHunksToDiffRows", () => {
  it("numbers lines per side from each hunk's start and strips line ends", () => {
    const rows = gitHunksToDiffRows([
      hunk({
        header: "@@ -10,3 +12,3 @@ fn x",
        oldStart: 10,
        newStart: 12,
        lines: [
          { kind: "context", content: "keep\n" },
          { kind: "del", content: "old\r\n" },
          { kind: "add", content: "new\n" },
          { kind: "context", content: "tail" },
        ],
      }),
    ])
    expect(rows[0]).toEqual({ kind: "header", key: "hunk-0", text: "@@ -10,3 +12,3 @@ fn x" })
    expect(rows.slice(1)).toEqual([
      {
        kind: "line",
        index: 0,
        line: { type: "unchanged", content: "keep", oldLineNum: 10, newLineNum: 12 },
      },
      { kind: "line", index: 1, line: { type: "removed", content: "old", oldLineNum: 11 } },
      { kind: "line", index: 2, line: { type: "added", content: "new", newLineNum: 13 } },
      {
        kind: "line",
        index: 3,
        line: { type: "unchanged", content: "tail", oldLineNum: 12, newLineNum: 14 },
      },
    ])
  })

  it("emits one header per hunk", () => {
    const rows = gitHunksToDiffRows([hunk(), hunk({ header: "@@ -20 +20 @@" })])
    expect(rows.filter((r) => r.kind === "header")).toHaveLength(2)
  })
})

describe("hunkStats", () => {
  it("counts adds and deletes across hunks", () => {
    expect(
      hunkStats([
        hunk({
          lines: [
            { kind: "add", content: "a" },
            { kind: "context", content: "c" },
          ],
        }),
        hunk({
          lines: [
            { kind: "del", content: "d" },
            { kind: "add", content: "e" },
          ],
        }),
      ])
    ).toEqual({ added: 2, removed: 1 })
  })
})

describe("hunkIndexAtLine", () => {
  const hunks = [
    hunk({ newStart: 5, newLines: 4 }),
    hunk({ newStart: 20, newLines: 0 }),
    hunk({ newStart: 40, newLines: 2 }),
  ]

  it("is -1 above the first hunk", () => {
    expect(hunkIndexAtLine(hunks, 1)).toBe(-1)
  })

  it("returns the covering hunk", () => {
    expect(hunkIndexAtLine(hunks, 8)).toBe(0)
    expect(hunkIndexAtLine(hunks, 41)).toBe(2)
  })

  it("lets a pure deletion own its anchor line", () => {
    expect(hunkIndexAtLine(hunks, 20)).toBe(1)
  })

  it("falls back to the last hunk before the line", () => {
    expect(hunkIndexAtLine(hunks, 30)).toBe(1)
    expect(hunkIndexAtLine(hunks, 99)).toBe(2)
  })
})

describe("review file order", () => {
  const s = status({
    merge: [change("m.ts", "merge")],
    staged: [change("a.ts", "staged")],
    changes: [change("a.ts", "changes"), change("b.ts", "changes")],
  })

  it("walks Merge, Staged, Changes like the list", () => {
    expect(orderedReviewFiles(s)).toEqual([
      { path: "m.ts", staged: false },
      { path: "a.ts", staged: true },
      { path: "a.ts", staged: false },
      { path: "b.ts", staged: false },
    ])
    expect(orderedReviewFiles(null)).toEqual([])
  })

  it("finds neighbours by path and side", () => {
    const files = orderedReviewFiles(s)
    expect(reviewFileNeighbours(files, { path: "a.ts", staged: false })).toEqual({
      index: 2,
      prev: { path: "a.ts", staged: true },
      next: { path: "b.ts", staged: false },
    })
    expect(reviewFileNeighbours(files, { path: "m.ts", staged: false }).prev).toBeNull()
    expect(reviewFileNeighbours(files, { path: "b.ts", staged: false }).next).toBeNull()
    expect(reviewFileNeighbours(files, { path: "zz", staged: false }).index).toBe(-1)
    expect(reviewFileNeighbours(files, null).index).toBe(-1)
  })

  it("opens the staged side for a file that is only staged", () => {
    const only = status({ staged: [change("s.ts", "staged")] })
    expect(resolveReviewSide(only, "s.ts")).toEqual({ path: "s.ts", staged: true })
    expect(resolveReviewSide(s, "a.ts")).toEqual({ path: "a.ts", staged: false })
    expect(resolveReviewSide(s, "m.ts")).toEqual({ path: "m.ts", staged: false })
    expect(resolveReviewSide(null, "x")).toEqual({ path: "x", staged: false })
  })
})
