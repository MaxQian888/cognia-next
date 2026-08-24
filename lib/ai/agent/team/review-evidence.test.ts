import { buildReviewEvidence, MAX_REVIEW_DIFF_BYTES, type ReviewGitOps } from "./review-evidence"
import type { GitDiff, GitFileChange, GitStatus } from "@/types/git"
import type { PromotionWorkspaceHandle } from "./workspace/promotion"

const handle: PromotionWorkspaceHandle = {
  key: "t1",
  logicalRootId: "app",
  runId: "run1",
  teammateName: "Coder",
  taskId: "t1",
  branch: "agent/run1/coder/t1",
  path: "/wt/t1",
}

const change = (path: string, staged = false): GitFileChange =>
  ({ path, origPath: null, status: "modified", staged, group: "changes" }) as GitFileChange

const diff = (path: string, patch: string): GitDiff =>
  ({
    path,
    oldContent: "",
    newContent: "",
    isBinary: false,
    hunks: [{ header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch, lines: [] }],
  }) as GitDiff

const status = (over: Partial<GitStatus> = {}): GitStatus =>
  ({
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    merge: [],
    isRebasing: false,
    ...over,
  }) as GitStatus

function makeGit(over: Partial<ReviewGitOps> = {}): ReviewGitOps {
  return {
    diffRefsFiles: jest.fn(async () => []),
    diffRefsFile: jest.fn(async () => diff("a.ts", "@@ -1 +1 @@\n-a\n+b")),
    status: jest.fn(async () => status()),
    diffFile: jest.fn(async () => diff("a.ts", "@@ -1 +1 @@\n-a\n+b")),
    ...over,
  }
}

/** The Registry promotion commit — required alongside a managed environment. */
let commit: jest.Mock<Promise<string | null>, [unknown, string]>
beforeEach(() => {
  commit = jest.fn<Promise<string | null>, [unknown, string]>(async () => "sha1")
})

describe("buildReviewEvidence — worktree branch (preferred)", () => {
  it("commits the worker's work and diffs the branch against the run's base", async () => {
    // The worker is not required to commit; without this the branch has nothing
    // to diff against base and every review would see an empty change set.
    const git = makeGit({ diffRefsFiles: jest.fn(async () => [change("a.ts")]) })

    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit, baseRef: "main" },
      taskId: "t1",
      git,
    })

    expect(commit).toHaveBeenCalledWith(handle, expect.stringContaining("t1"))
    expect(git.diffRefsFiles).toHaveBeenCalledWith("/repo", "main", "agent/run1/coder/t1")
    expect(ev.kind).toBe("commit")
    expect(ev.commitSha).toBe("sha1")
    expect(ev.files).toEqual(["a.ts"])
    expect(ev.diff).toContain("+b")
    expect(ev.truncated).toBe(false)
  })

  it("reports no sha when the tree was already clean", async () => {
    // The usual case: dispatchTeammate already committed the worker's work, so
    // our commit is a no-op. The caller then falls back to the sha the
    // dispatcher recorded — this function only reports what IT committed.
    const git = makeGit({ diffRefsFiles: jest.fn(async () => [change("a.ts")]) })
    commit.mockResolvedValueOnce(null)

    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
      git,
    })

    expect(ev.kind).toBe("commit")
    expect(ev.commitSha).toBeUndefined()
    expect(ev.files).toEqual(["a.ts"])
  })

  it("diffs cumulatively against base, so a revision round still sees the whole change", async () => {
    // Not `HEAD~1..HEAD`: a second commit would otherwise show only the delta
    // since the lead's feedback, hiding the work being approved.
    const git = makeGit({ diffRefsFiles: jest.fn(async () => [change("a.ts")]) })
    await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit, baseRef: "main" },
      taskId: "t1",
      git,
    })
    expect(git.diffRefsFiles).toHaveBeenCalledWith("/repo", "main", handle.branch)
  })

  it("defaults the base ref to HEAD", async () => {
    const git = makeGit({ diffRefsFiles: jest.fn(async () => [change("a.ts")]) })
    await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
      git,
    })
    expect(git.diffRefsFiles).toHaveBeenCalledWith("/repo", "HEAD", handle.branch)
  })

  it("falls back to text when the worker changed nothing", async () => {
    const git = makeGit({ diffRefsFiles: jest.fn(async () => []) })
    commit.mockResolvedValueOnce(null)
    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
      git,
    })
    expect(ev).toEqual({ kind: "text", truncated: false, files: [] })
  })

  it("drops to the worktree's uncommitted changes when the branch diff fails", async () => {
    // A git hiccup on the branch must not cost the lead its evidence.
    const git = makeGit({
      diffRefsFiles: jest.fn(async () => {
        throw new Error("not a git repo")
      }),
      status: jest.fn(async () => status({ changes: [change("c.ts")] })),
      diffFile: jest.fn(async () => diff("c.ts", "@@ -1 +1 @@\n-p\n+q")),
    })
    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
      git,
    })
    // Diffed the WORKTREE, never the shared dir — the work lives here.
    expect(ev.kind).toBe("worktree")
    expect(ev.files).toEqual(["c.ts"])
    expect(git.status).toHaveBeenCalledWith("/wt/t1")
  })

  it("falls back to text when both the branch and the worktree are clean", async () => {
    // e.g. a mode-only change: git names the file, the diff carries no hunks.
    const git = makeGit({
      diffRefsFiles: jest.fn(async () => [change("a.ts")]),
      diffRefsFile: jest.fn(async () => ({ ...diff("a.ts", ""), hunks: [] }) as GitDiff),
    })
    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
      git,
    })
    expect(ev.kind).toBe("text")
  })
})

describe("buildReviewEvidence — shared working dir (isolation off)", () => {
  it("diffs uncommitted changes", async () => {
    const git = makeGit({
      status: jest.fn(async () => status({ changes: [change("b.ts")] })),
      diffFile: jest.fn(async () => diff("b.ts", "@@ -1 +1 @@\n-x\n+y")),
    })

    const ev = await buildReviewEvidence({ workingDir: "/repo", taskId: "t1", git })

    expect(ev.kind).toBe("worktree")
    expect(ev.files).toEqual(["b.ts"])
    expect(ev.diff).toContain("+y")
    expect(git.diffFile).toHaveBeenCalledWith("/repo", "b.ts", false)
  })

  it("covers staged changes too, without double-counting a path", async () => {
    const git = makeGit({
      status: jest.fn(async () =>
        status({ staged: [change("b.ts", true)], changes: [change("b.ts")] })
      ),
    })
    const ev = await buildReviewEvidence({ workingDir: "/repo", taskId: "t1", git })
    expect(ev.files).toEqual(["b.ts"])
  })

  it("falls back to text when the tree is clean", async () => {
    const git = makeGit({ status: jest.fn(async () => status()) })
    const ev = await buildReviewEvidence({ workingDir: "/repo", taskId: "t1", git })
    expect(ev.kind).toBe("text")
  })

  it("falls back to text when git fails, rather than approving blind", async () => {
    const git = makeGit({
      status: jest.fn(async () => {
        throw new Error("git bridge unavailable")
      }),
    })
    const ev = await buildReviewEvidence({ workingDir: "/repo", taskId: "t1", git })
    expect(ev.kind).toBe("text")
  })

  it("falls back to text when every changed file yields an empty patch", async () => {
    const git = makeGit({
      status: jest.fn(async () => status({ changes: [change("b.ts")] })),
      diffFile: jest.fn(async () => ({ ...diff("b.ts", ""), hunks: [] }) as GitDiff),
    })
    const ev = await buildReviewEvidence({ workingDir: "/repo", taskId: "t1", git })
    expect(ev.kind).toBe("text")
  })
})

describe("buildReviewEvidence — default git wiring", () => {
  // The seam defaults to the real `lib/git/commands` wrappers. Those are inert
  // off-desktop (no git bridge), which is exactly why this degrades to text
  // rather than throwing on web/mobile.
  it("uses the real wrappers when no seam is injected", async () => {
    const ev = await buildReviewEvidence({ workingDir: "/repo", taskId: "t1" })
    expect(ev.kind).toBe("text")
  })

  it("degrades to text on a worktree when the real wrappers are inert", async () => {
    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
    })
    expect(ev.kind).toBe("text")
    // It still asked the Registry promotion controller to commit — this module
    // decides whether git is reachable.
    expect(commit).toHaveBeenCalled()
  })
})

describe("buildReviewEvidence — no repo at all", () => {
  it("reviews the deliverable text", async () => {
    const ev = await buildReviewEvidence({ taskId: "t1", git: makeGit() })
    expect(ev).toEqual({ kind: "text", truncated: false, files: [] })
  })
})

describe("buildReviewEvidence — size cap", () => {
  it("drops whole files past the cap and says so", async () => {
    const big = "@@\n" + "+x".repeat(MAX_REVIEW_DIFF_BYTES)
    const git = makeGit({
      diffRefsFiles: jest.fn(async () => [change("small.ts"), change("huge.ts")]),
      diffRefsFile: jest.fn(async (_r: string, _b: string, _t: string, path: string) =>
        diff(path, path === "huge.ts" ? big : "@@ -1 +1 @@\n-a\n+b")
      ),
    })

    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
      git,
    })

    expect(ev.files).toEqual(["small.ts"])
    expect(ev.truncated).toBe(true)
    // A truncated patch that doesn't announce itself reads as a complete one.
    expect(ev.diff).toContain("huge.ts")
    expect(ev.diff).toMatch(/omitted/)
    expect(new TextEncoder().encode(ev.diff!).length).toBeLessThan(
      MAX_REVIEW_DIFF_BYTES + big.length
    )
  })

  it("keeps every file when they fit", async () => {
    const git = makeGit({
      diffRefsFiles: jest.fn(async () => [change("a.ts"), change("b.ts")]),
      diffRefsFile: jest.fn(async (_r: string, _b: string, _t: string, path: string) =>
        diff(path, "@@ -1 +1 @@\n-a\n+b")
      ),
    })
    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
      git,
    })
    expect(ev.files).toEqual(["a.ts", "b.ts"])
    expect(ev.truncated).toBe(false)
    expect(ev.diff).not.toMatch(/omitted/)
  })

  it("marks a binary file rather than dumping it", async () => {
    const git = makeGit({
      diffRefsFiles: jest.fn(async () => [change("logo.png")]),
      diffRefsFile: jest.fn(async () => ({ ...diff("logo.png", ""), isBinary: true }) as GitDiff),
    })
    const ev = await buildReviewEvidence({
      worktree: { handle, repoPath: "/repo", commit },
      taskId: "t1",
      git,
    })
    expect(ev.diff).toContain("binary file changed")
  })
})
