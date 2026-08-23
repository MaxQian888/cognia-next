const gitStatusMock = jest.fn()
const gitCommitFilesMock = jest.fn()
const gitDiffRefsFilesMock = jest.fn()
const gitDiffFileMock = jest.fn()
const gitDiffCommitMock = jest.fn()
const gitDiffRefsFileMock = jest.fn()
jest.mock("@/lib/git/commands", () => ({
  gitStatus: (...args: unknown[]) => gitStatusMock(...args),
  gitCommitFiles: (...args: unknown[]) => gitCommitFilesMock(...args),
  gitDiffRefsFiles: (...args: unknown[]) => gitDiffRefsFilesMock(...args),
  gitDiffFile: (...args: unknown[]) => gitDiffFileMock(...args),
  gitDiffCommit: (...args: unknown[]) => gitDiffCommitMock(...args),
  gitDiffRefsFile: (...args: unknown[]) => gitDiffRefsFileMock(...args),
}))
const getTaskPatchSetMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  getTaskPatchSet: (...args: unknown[]) => getTaskPatchSetMock(...args),
}))

import {
  listReviewScopeFiles,
  loadReviewScopeFile,
  refsForRoot,
  type ReviewScopeRequest,
  type ReviewScopedFile,
} from "./scope"

/**
 * List-then-load-everything, as a test helper.
 *
 * `collectReviewScope` used to be exported for this, but once the sheet moved
 * to lazy loading nothing called it — an uncalled export with its own tests is
 * dormancy, and the behaviour it pinned is exactly the composition below.
 */
async function collectReviewScope(request: ReviewScopeRequest): Promise<ReviewScopedFile[]> {
  const { files } = await listReviewScopeFiles(request)
  return Promise.all(files.map((ref) => loadReviewScopeFile(request, ref)))
}

const file = (path: string, staged = false) => ({
  path,
  origPath: null,
  status: "modified",
  staged,
  group: staged ? "staged" : "changes",
})

beforeEach(() => {
  gitStatusMock.mockReset().mockResolvedValue({ staged: [], changes: [], merge: [] })
  gitCommitFilesMock.mockReset().mockResolvedValue([])
  gitDiffRefsFilesMock.mockReset().mockResolvedValue([])
  gitDiffFileMock.mockReset().mockResolvedValue({ hunks: [] })
  gitDiffCommitMock.mockReset().mockResolvedValue({ hunks: [] })
  gitDiffRefsFileMock.mockReset().mockResolvedValue({ hunks: [] })
  getTaskPatchSetMock.mockReset().mockResolvedValue(null)
})

it("collects last-turn Task Workspace patches across selected roots", async () => {
  getTaskPatchSetMock
    .mockResolvedValueOnce({
      files: [
        {
          path: "b.ts",
          oldPath: null,
          kind: "modified",
          hunks: [
            {
              id: "hunk:1:legacy",
              header: "@@ -3,2 +3,4 @@",
              forwardPatchHash: "content-b",
            },
          ],
        },
      ],
    })
    .mockResolvedValueOnce({
      files: [{ path: "a.ts", oldPath: "old.ts", kind: "renamed", hunks: [] }],
    })
  await expect(
    collectReviewScope({
      scope: "lastTurn",
      repositoryRoots: ["/repo-b", "/repo-a"],
      refsByRoot: {
        "/repo-a": { lastTurnRunId: "run-a" },
        "/repo-b": { lastTurnRunId: "run-b" },
      },
    })
  ).resolves.toEqual([
    expect.objectContaining({ repositoryRoot: "/repo-a", path: "a.ts", oldPath: "old.ts" }),
    expect.objectContaining({
      repositoryRoot: "/repo-b",
      path: "b.ts",
      hunks: [expect.objectContaining({ hunkHash: "content-b", side: "after", line: 3 })],
    }),
  ])
})

it("collects staged and unstaged uncommitted files without collapsing their states", async () => {
  gitStatusMock.mockResolvedValue({
    staged: [file("a.ts", true)],
    changes: [file("a.ts"), file("b.ts")],
    merge: [],
  })
  const files = await collectReviewScope({ scope: "uncommitted", repositoryRoots: ["/repo"] })
  expect(files).toHaveLength(3)
  expect(files.filter((entry) => entry.path === "a.ts").map((entry) => entry.staged)).toEqual([
    false,
    true,
  ])
  expect(gitDiffFileMock).toHaveBeenCalledWith("/repo", "a.ts", false)
  expect(gitDiffFileMock).toHaveBeenCalledWith("/repo", "a.ts", true)
})

it("collects one commit", async () => {
  gitCommitFilesMock.mockResolvedValue([file("commit.ts")])
  await collectReviewScope({
    scope: "commit",
    repositoryRoots: ["/repo"],
    defaults: { commitSha: "abc" },
  })
  expect(gitCommitFilesMock).toHaveBeenCalledWith("/repo", "abc")
  expect(gitDiffCommitMock).toHaveBeenCalledWith("/repo", "abc", "commit.ts")
})

it("collects a branch comparison", async () => {
  gitDiffRefsFilesMock.mockResolvedValue([file("branch.ts")])
  await collectReviewScope({
    scope: "branch",
    repositoryRoots: ["/repo"],
    defaults: { baseRef: "main", targetRef: "feature" },
  })
  expect(gitDiffRefsFilesMock).toHaveBeenCalledWith("/repo", "main", "feature")
  expect(gitDiffRefsFileMock).toHaveBeenCalledWith("/repo", "main", "feature", "branch.ts")
})

it("derives content-addressed anchors from parsed Git hunks", async () => {
  gitStatusMock.mockResolvedValue({
    staged: [],
    changes: [file("a.ts")],
    merge: [],
  })
  gitDiffFileMock.mockResolvedValue({
    hunks: [
      {
        header: "@@ -8,2 +8,0 @@",
        oldStart: 8,
        oldLines: 2,
        newStart: 8,
        newLines: 0,
        patch: "delete",
        lines: [{ kind: "del", content: "removed" }],
      },
    ],
  })

  const [entry] = await collectReviewScope({
    scope: "uncommitted",
    repositoryRoots: ["/repo"],
  })

  expect(entry.hunks).toEqual([
    expect.objectContaining({ side: "before", line: 8, hunkHash: expect.any(String) }),
  ])
  expect(entry.hunks[0]?.hunkHash).not.toContain("uncommitted:a.ts")
})

/**
 * Missing selectors no longer throw — they name the root that is unscopeable,
 * so the roots that ARE scopeable still load. Nothing is reviewed for a root
 * with no selector either way; the difference is whether its siblings survive.
 */
it("reports, rather than throws, when a required scope selector is missing", async () => {
  const commit = await listReviewScopeFiles({ scope: "commit", repositoryRoots: ["/repo"] })
  expect(commit.files).toEqual([])
  expect(commit.unavailable).toEqual([{ repositoryRoot: "/repo", reason: "missing-commit" }])

  const branch = await listReviewScopeFiles({ scope: "branch", repositoryRoots: ["/repo"] })
  expect(branch.unavailable).toEqual([{ repositoryRoot: "/repo", reason: "missing-refs" }])
})

it("still refuses a review with no repository at all", async () => {
  await expect(listReviewScopeFiles({ scope: "uncommitted", repositoryRoots: [] })).rejects.toThrow(
    /repository root/
  )
})

describe("per-repository refs", () => {
  /**
   * Two roots in one review are two repositories. A commit SHA from one is
   * meaningless in the other, and `main` may not exist there at all — which is
   * what the single-ref request applied to every selected root.
   */
  it("asks each repository about its OWN base and target", async () => {
    gitDiffRefsFilesMock.mockResolvedValue([])
    await listReviewScopeFiles({
      scope: "branch",
      repositoryRoots: ["/repo-a", "/repo-b"],
      refsByRoot: {
        "/repo-a": { baseRef: "main", targetRef: "feature-a" },
        "/repo-b": { baseRef: "develop", targetRef: "feature-b" },
      },
    })
    expect(gitDiffRefsFilesMock).toHaveBeenCalledWith("/repo-a", "main", "feature-a")
    expect(gitDiffRefsFilesMock).toHaveBeenCalledWith("/repo-b", "develop", "feature-b")
  })

  it("falls back to the shared defaults for a root with no entry", async () => {
    gitDiffRefsFilesMock.mockResolvedValue([])
    await listReviewScopeFiles({
      scope: "branch",
      repositoryRoots: ["/repo-a", "/repo-b"],
      defaults: { baseRef: "main", targetRef: "HEAD" },
      refsByRoot: { "/repo-b": { targetRef: "feature-b" } },
    })
    expect(gitDiffRefsFilesMock).toHaveBeenCalledWith("/repo-a", "main", "HEAD")
    // Per-root wins key by key: base still comes from the defaults.
    expect(gitDiffRefsFilesMock).toHaveBeenCalledWith("/repo-b", "main", "feature-b")
  })

  /**
   * Only ONE root can have a last-turn run — the one the active task wrote in.
   * Throwing meant a multi-root last-turn review failed entirely, including for
   * the root that did have a run.
   */
  it("reports a root with no refs instead of failing the whole review", async () => {
    gitCommitFilesMock.mockResolvedValue([file("a.ts")])
    const listing = await listReviewScopeFiles({
      scope: "commit",
      repositoryRoots: ["/repo-a", "/repo-b"],
      refsByRoot: { "/repo-a": { commitSha: "abc" } },
    })
    expect(listing.files.map((entry) => entry.repositoryRoot)).toEqual(["/repo-a"])
    expect(listing.unavailable).toEqual([{ repositoryRoot: "/repo-b", reason: "missing-commit" }])
  })

  it("keeps the root that HAS a last-turn run when a sibling has none", async () => {
    getTaskPatchSetMock.mockResolvedValue({
      files: [{ path: "a.ts", kind: "modified", hunks: [] }],
    })
    const listing = await listReviewScopeFiles({
      scope: "lastTurn",
      repositoryRoots: ["/repo-a", "/repo-b"],
      refsByRoot: { "/repo-a": { lastTurnRunId: "run-a" } },
    })
    expect(listing.files).toHaveLength(1)
    expect(listing.unavailable).toEqual([{ repositoryRoot: "/repo-b", reason: "missing-run" }])
  })

  /** A git failure is not "nothing to review" and must still surface. */
  it("still throws when git itself fails", async () => {
    gitCommitFilesMock.mockRejectedValue(new Error("bad object"))
    await expect(
      listReviewScopeFiles({
        scope: "commit",
        repositoryRoots: ["/repo-a"],
        refsByRoot: { "/repo-a": { commitSha: "abc" } },
      })
    ).rejects.toThrow(/bad object/)
  })

  it("merges defaults under per-root entries", () => {
    const request = {
      scope: "branch" as const,
      repositoryRoots: ["/r"],
      defaults: { baseRef: "main", targetRef: "HEAD" },
      refsByRoot: { "/r": { targetRef: "feature" } },
    }
    expect(refsForRoot(request, "/r")).toEqual({ baseRef: "main", targetRef: "feature" })
    expect(refsForRoot(request, "/other")).toEqual({ baseRef: "main", targetRef: "HEAD" })
  })
})

describe("listing before loading", () => {
  /**
   * The single-step version fired one full diff RPC per changed file, across
   * every root, before anything could render.
   */
  it("costs one RPC per root and none per file", async () => {
    gitDiffRefsFilesMock.mockResolvedValue([file("a.ts"), file("b.ts"), file("c.ts")])
    const { files: refs } = await listReviewScopeFiles({
      scope: "branch",
      repositoryRoots: ["/repo"],
      defaults: { baseRef: "main", targetRef: "feature" },
    })
    expect(refs).toHaveLength(3)
    expect(gitDiffRefsFilesMock).toHaveBeenCalledTimes(1)
    expect(gitDiffRefsFileMock).not.toHaveBeenCalled()
  })

  it("loads one file's hunks on demand", async () => {
    gitDiffRefsFilesMock.mockResolvedValue([file("a.ts")])
    const request = {
      scope: "branch" as const,
      repositoryRoots: ["/repo"],
      defaults: { baseRef: "main", targetRef: "feature" },
    }
    const [ref] = (await listReviewScopeFiles(request)).files
    gitDiffRefsFileMock.mockResolvedValue({
      hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, newStart: 1, newLines: 1, lines: [] }],
    })
    const loaded = await loadReviewScopeFile(request, ref)
    expect(loaded.hunks).toHaveLength(1)
    expect(gitDiffRefsFileMock).toHaveBeenCalledWith("/repo", "main", "feature", "a.ts")
  })

  /** Task Workspace patch sets arrive complete; asking again is a second read. */
  it("does not re-fetch a last-turn file whose hunks came with the listing", async () => {
    getTaskPatchSetMock.mockResolvedValue({
      files: [
        {
          path: "a.ts",
          kind: "modified",
          hunks: [{ header: "@@ -1 +1,2 @@", forwardPatchHash: "h" }],
        },
      ],
    })
    const request = {
      scope: "lastTurn" as const,
      repositoryRoots: ["/repo"],
      refsByRoot: { "/repo": { lastTurnRunId: "run-1" } },
    }
    const [ref] = (await listReviewScopeFiles(request)).files
    expect(ref.hunks).toHaveLength(1)
    getTaskPatchSetMock.mockClear()
    const loaded = await loadReviewScopeFile(request, ref)
    expect(loaded.hunks).toHaveLength(1)
    expect(getTaskPatchSetMock).not.toHaveBeenCalled()
  })

  it("still returns everything through the compatibility wrapper", async () => {
    gitStatusMock.mockResolvedValue({ staged: [], changes: [file("a.ts")], merge: [] })
    gitDiffFileMock.mockResolvedValue({
      hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, newStart: 1, newLines: 1, lines: [] }],
    })
    const files = await collectReviewScope({ scope: "uncommitted", repositoryRoots: ["/repo"] })
    expect(files[0].hunks).toHaveLength(1)
  })
})
