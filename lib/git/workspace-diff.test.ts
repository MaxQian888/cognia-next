import { readWorkspaceDiff, type WorkspaceDiffReaderDeps } from "./workspace-diff"
import type { GitDiff, GitFileChange, GitStatus } from "@/types/git"

function change(path: string, staged: boolean): GitFileChange {
  return { path, origPath: null, status: "modified", staged, group: staged ? "staged" : "changes" }
}

function status(partial: Partial<GitStatus>): GitStatus {
  return {
    branch: "dev",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    merge: [],
    isRebasing: false,
    isMerging: false,
    ...partial,
  }
}

function diff(path: string, patches: string[], isBinary = false): GitDiff {
  return {
    path,
    oldContent: "",
    newContent: "",
    isBinary,
    language: null,
    hunks: patches.map((patch, index) => ({
      header: `@@ -${index + 1} +${index + 1} @@`,
      oldStart: index + 1,
      oldLines: 1,
      newStart: index + 1,
      newLines: 1,
      patch,
      lines: [],
    })),
  }
}

function deps(overrides: Partial<WorkspaceDiffReaderDeps> = {}): WorkspaceDiffReaderDeps {
  return {
    isRepo: jest.fn(async () => true),
    status: jest.fn(async () => status({})),
    diffFile: jest.fn(async (_repo, path) => diff(path, [])),
    ...overrides,
  }
}

describe("readWorkspaceDiff", () => {
  it("answers empty outside a repository without reading status", async () => {
    const d = deps({ isRepo: jest.fn(async () => false) })
    await expect(readWorkspaceDiff("/repo", { deps: d })).resolves.toEqual({
      text: "",
      fileCount: 0,
      truncated: false,
    })
    expect(d.status).not.toHaveBeenCalled()
  })

  it("answers empty for a blank path", async () => {
    const d = deps()
    await expect(readWorkspaceDiff("   ", { deps: d })).resolves.toMatchObject({ text: "" })
    expect(d.isRepo).not.toHaveBeenCalled()
  })

  it("joins the hunks of every changed path, staged and unstaged labelled apart", async () => {
    const d = deps({
      status: jest.fn(async () =>
        status({
          staged: [change("a.ts", true)],
          changes: [change("a.ts", false), change("b.ts", false)],
        })
      ),
      diffFile: jest.fn(async (_repo, path, staged) =>
        diff(path, [`--- ${path} ${staged ? "index" : "tree"}`])
      ),
    })
    const snapshot = await readWorkspaceDiff("/repo", { deps: d })
    expect(snapshot.fileCount).toBe(2)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.text).toContain("# a.ts (staged)\n--- a.ts index")
    expect(snapshot.text).toContain("# a.ts\n--- a.ts tree")
    expect(snapshot.text).toContain("# b.ts\n--- b.ts tree")
    expect(d.diffFile).toHaveBeenCalledTimes(3)
  })

  it("skips binary files and paths with no hunks", async () => {
    const d = deps({
      status: jest.fn(async () =>
        status({ changes: [change("img.png", false), change("x.ts", false)] })
      ),
      diffFile: jest.fn(async (_repo, path) =>
        path === "img.png" ? diff(path, ["binary"], true) : diff(path, [])
      ),
    })
    await expect(readWorkspaceDiff("/repo", { deps: d })).resolves.toMatchObject({
      text: "",
      fileCount: 0,
    })
  })

  it("clamps to the budget and says so", async () => {
    const d = deps({
      status: jest.fn(async () => status({ changes: [change("big.ts", false)] })),
      diffFile: jest.fn(async (_repo, path) => diff(path, ["x".repeat(500)])),
    })
    const snapshot = await readWorkspaceDiff("/repo", { deps: d, maxChars: 100 })
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.text.length).toBeLessThan(200)
    expect(snapshot.text).toContain("truncated")
  })
})
