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

import { collectReviewScope } from "./scope"

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
      lastTurnRunIdByRoot: { "/repo-a": "run-a", "/repo-b": "run-b" },
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
    commitSha: "abc",
  })
  expect(gitCommitFilesMock).toHaveBeenCalledWith("/repo", "abc")
  expect(gitDiffCommitMock).toHaveBeenCalledWith("/repo", "abc", "commit.ts")
})

it("collects a branch comparison", async () => {
  gitDiffRefsFilesMock.mockResolvedValue([file("branch.ts")])
  await collectReviewScope({
    scope: "branch",
    repositoryRoots: ["/repo"],
    baseRef: "main",
    targetRef: "feature",
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

it("fails closed when required scope selectors are missing", async () => {
  await expect(collectReviewScope({ scope: "commit", repositoryRoots: ["/repo"] })).rejects.toThrow(
    /commit SHA/
  )
  await expect(collectReviewScope({ scope: "branch", repositoryRoots: ["/repo"] })).rejects.toThrow(
    /base and target/
  )
})
