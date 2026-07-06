import {
  countUnmappedDecisions,
  fnv1aHash,
  hunkContentHash,
  normalizeReviewKey,
  replayDecisions,
  selectAcceptedPatches,
  type StoredHunkDecision,
} from "@/lib/git/hunk-review"
import type { GitHunk } from "@/types/git"

function hunk(over: Partial<GitHunk> & { lines: GitHunk["lines"] }): GitHunk {
  return {
    header: "@@",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    patch: "patch",
    ...over,
  }
}

const ctx = (content: string) => ({ kind: "context", content })
const add = (content: string) => ({ kind: "add", content })
const del = (content: string) => ({ kind: "del", content })

describe("fnv1aHash", () => {
  it("is deterministic and differs by input", () => {
    expect(fnv1aHash("a")).toBe(fnv1aHash("a"))
    expect(fnv1aHash("a")).not.toBe(fnv1aHash("b"))
  })
})

describe("hunkContentHash", () => {
  it("derives old/new content by excluding added/deleted lines respectively", () => {
    const h = hunk({ lines: [ctx("keep"), del("gone"), add("fresh")] })
    // old = keep\ngone ; new = keep\nfresh
    expect(hunkContentHash(h)).toBe(fnv1aHash("keep\ngone\nkeep\nfresh"))
  })

  it("is stable across index shifts when the body is unchanged", () => {
    const h = hunk({ lines: [ctx("x"), add("y")] })
    expect(hunkContentHash({ ...h, newStart: 5 })).toBe(hunkContentHash({ ...h, newStart: 99 }))
  })
})

describe("normalizeReviewKey", () => {
  it("normalizes backslashes and lowercases a Windows drive", () => {
    expect(normalizeReviewKey({ path: "C:\\Repo\\A.ts", origPath: null, status: "modified" })).toBe(
      "c:/Repo/A.ts"
    )
  })

  it("uses a rename alias for renamed files", () => {
    expect(normalizeReviewKey({ path: "new/b.ts", origPath: "old/a.ts", status: "renamed" })).toBe(
      "rename:old/a.ts->new/b.ts"
    )
  })

  it("ignores origPath for non-renames", () => {
    expect(normalizeReviewKey({ path: "a.ts", origPath: "x.ts", status: "modified" })).toBe("a.ts")
  })
})

describe("replayDecisions", () => {
  it("remaps a decision to a uniquely-matching shifted hunk", () => {
    const h0 = hunk({ lines: [ctx("k"), add("v")] })
    const stored: StoredHunkDecision[] = [
      { hunkIndex: 5, hash: hunkContentHash(h0), decision: "accepted" },
    ]
    // Current diff: the same hunk is now at index 1.
    const current = [hunk({ lines: [add("other")] }), h0]
    const out = replayDecisions(stored, current)
    expect(out.get(1)).toEqual({ decision: "accepted", comment: undefined })
    expect(out.has(0)).toBe(false)
  })

  it("drops a decision when two hunks share the same hash (ambiguous)", () => {
    const h = hunk({ lines: [ctx("dup")] })
    const stored: StoredHunkDecision[] = [
      { hunkIndex: 0, hash: hunkContentHash(h), decision: "rejected" },
    ]
    const out = replayDecisions(stored, [h, { ...h }])
    expect(out.size).toBe(0)
  })

  it("drops a decision when no current hunk matches", () => {
    const stored: StoredHunkDecision[] = [{ hunkIndex: 0, hash: "deadbeef", decision: "accepted" }]
    expect(replayDecisions(stored, [hunk({ lines: [add("x")] })]).size).toBe(0)
  })

  it("carries a comment even on an undecided hunk", () => {
    const h = hunk({ lines: [ctx("c")] })
    const out = replayDecisions(
      [{ hunkIndex: 0, hash: hunkContentHash(h), decision: "undecided", comment: "look here" }],
      [h]
    )
    expect(out.get(0)?.comment).toBe("look here")
  })

  it("carries an AI finding through the remap, even on an undecided hunk", () => {
    const h = hunk({ lines: [ctx("c")] })
    const out = replayDecisions(
      [
        {
          hunkIndex: 0,
          hash: hunkContentHash(h),
          decision: "undecided",
          ai: { severity: "critical", note: "bug" },
        },
      ],
      [h]
    )
    expect(out.get(0)?.ai).toEqual({ severity: "critical", note: "bug" })
  })
})

describe("countUnmappedDecisions", () => {
  it("counts actionable decisions that could not be remapped", () => {
    const matched = hunk({ lines: [ctx("m")] })
    const stored: StoredHunkDecision[] = [
      { hunkIndex: 0, hash: hunkContentHash(matched), decision: "accepted" },
      { hunkIndex: 1, hash: "missing", decision: "rejected" },
      { hunkIndex: 2, hash: "x", decision: "undecided" }, // not actionable → ignored
    ]
    expect(countUnmappedDecisions(stored, [matched])).toBe(1)
  })

  it("counts an unmapped AI-only finding as actionable", () => {
    const stored: StoredHunkDecision[] = [
      { hunkIndex: 0, hash: "gone", decision: "undecided", ai: { severity: "info", note: "n" } },
    ]
    expect(countUnmappedDecisions(stored, [hunk({ lines: [add("x")] })])).toBe(1)
  })
})

describe("selectAcceptedPatches", () => {
  it("returns accepted hunks sorted by newStart descending", () => {
    const a = hunk({ newStart: 10, lines: [add("a")] })
    const b = hunk({ newStart: 30, lines: [add("b")] })
    const c = hunk({ newStart: 20, lines: [add("c")] })
    const decisions = new Map([
      [0, { decision: "accepted" as const }],
      [1, { decision: "accepted" as const }],
      [2, { decision: "rejected" as const }],
    ])
    const out = selectAcceptedPatches([a, b, c], decisions)
    expect(out.map((h) => h.newStart)).toEqual([30, 10])
  })
})
