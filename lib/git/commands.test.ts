const isTauriMock = jest.fn()
const callMock = jest.fn()
const subscribeMock = jest.fn()

jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  transport: {
    call: (...args: unknown[]) => callMock(...args),
    subscribe: (...args: unknown[]) => subscribeMock(...args),
  },
}))

import {
  gitBranches,
  gitCheckoutBranch,
  gitCommit,
  gitConflicts,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiffFile,
  gitDiscard,
  gitDiscardAll,
  gitFetch,
  gitFileHistory,
  gitIsRepo,
  gitLog,
  gitMergeAbort,
  gitPull,
  gitPush,
  gitRenameBranch,
  gitRepoState,
  gitResolveConflict,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatus,
  gitSync,
  gitUnstage,
  gitWatchStart,
  gitWatchStop,
} from "./commands"
import { EMPTY_REPO_STATE, EMPTY_STATUS } from "@/types/git"

beforeEach(() => {
  isTauriMock.mockReset()
  callMock.mockReset()
  subscribeMock.mockReset()
})

describe("when not in Tauri", () => {
  beforeEach(() => isTauriMock.mockReturnValue(false))

  it("returns inert values without calling transport", async () => {
    expect(await gitIsRepo("/r")).toBe(false)
    expect(await gitRepoState("/r")).toBe(EMPTY_REPO_STATE)
    expect(await gitStatus("/r")).toBe(EMPTY_STATUS)
    expect(await gitBranches("/r")).toEqual([])
    expect(await gitStashList("/r")).toEqual([])
    expect(await gitConflicts("/r")).toEqual([])
    expect(await gitLog("/r", 10, 0)).toEqual([])
    expect(await gitFileHistory("/r", "a", 10)).toEqual([])
    expect(await gitCommit("/r", "m", false, false)).toBe("")
    expect(await gitSync("/r")).toEqual({ ahead: 0, behind: 0 })
    const diff = await gitDiffFile("/r", "a.ts", false)
    expect(diff.hunks).toEqual([])
    await gitStage("/r", ["a"])
    await gitUnstage("/r", ["a"])
    await gitDiscard("/r", ["a"])
    await gitWatchStart("/r")
    await gitWatchStop("/r")
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe("when in Tauri", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    callMock.mockResolvedValue(undefined)
  })

  it("reads call the right commands", async () => {
    callMock.mockResolvedValueOnce(true)
    await gitIsRepo("/r")
    expect(callMock).toHaveBeenCalledWith("git_is_repo", { repoPath: "/r" })

    callMock.mockResolvedValueOnce({ samples: [] })
    await gitStatus("/r")
    expect(callMock).toHaveBeenCalledWith("git_status", { repoPath: "/r" })

    callMock.mockResolvedValueOnce([])
    await gitLog("/r", 50, 10)
    expect(callMock).toHaveBeenCalledWith("git_log", { repoPath: "/r", maxCount: 50, skip: 10 })

    callMock.mockResolvedValueOnce([])
    await gitFileHistory("/r", "a.ts", 20)
    expect(callMock).toHaveBeenCalledWith("git_file_history", {
      repoPath: "/r",
      path: "a.ts",
      maxCount: 20,
    })
  })

  it("gitDiffFile injects a resolved language", async () => {
    callMock.mockResolvedValueOnce({
      path: "src/a.ts",
      oldContent: "",
      newContent: "",
      hunks: [],
      isBinary: false,
    })
    const diff = await gitDiffFile("/r", "src/a.ts", true)
    expect(callMock).toHaveBeenCalledWith("git_diff_file", {
      repoPath: "/r",
      path: "src/a.ts",
      staged: true,
    })
    expect(diff.language).toBe("typescript")
  })

  it("stage routes whole-file vs hunk patch", async () => {
    await gitStage("/r", ["a.ts"])
    expect(callMock).toHaveBeenCalledWith("git_stage", {
      repoPath: "/r",
      paths: ["a.ts"],
      hunkPatch: null,
    })
    await gitStage("/r", [], "PATCH")
    expect(callMock).toHaveBeenCalledWith("git_stage", {
      repoPath: "/r",
      paths: [],
      hunkPatch: "PATCH",
    })
  })

  it("unstage / discard / discardAll", async () => {
    await gitUnstage("/r", ["a"], "P")
    expect(callMock).toHaveBeenCalledWith("git_unstage", {
      repoPath: "/r",
      paths: ["a"],
      hunkPatch: "P",
    })
    await gitDiscard("/r", ["a"])
    expect(callMock).toHaveBeenCalledWith("git_discard", {
      repoPath: "/r",
      paths: ["a"],
      hunkPatch: null,
    })
    await gitDiscardAll("/r", true)
    expect(callMock).toHaveBeenCalledWith("git_discard_all", {
      repoPath: "/r",
      includeUntracked: true,
    })
  })

  it("commit passes flags", async () => {
    callMock.mockResolvedValueOnce("deadbeef")
    const sha = await gitCommit("/r", "msg", true, true)
    expect(callMock).toHaveBeenCalledWith("git_commit", {
      repoPath: "/r",
      message: "msg",
      amend: true,
      signoff: true,
    })
    expect(sha).toBe("deadbeef")
  })

  it("branch ops", async () => {
    await gitCheckoutBranch("/r", "feat")
    expect(callMock).toHaveBeenCalledWith("git_checkout_branch", { repoPath: "/r", name: "feat" })
    await gitCreateBranch("/r", "feat", true, "main")
    expect(callMock).toHaveBeenCalledWith("git_create_branch", {
      repoPath: "/r",
      name: "feat",
      checkout: true,
      from: "main",
    })
    await gitDeleteBranch("/r", "feat", true)
    expect(callMock).toHaveBeenCalledWith("git_delete_branch", {
      repoPath: "/r",
      name: "feat",
      force: true,
    })
    await gitRenameBranch("/r", "new", "old")
    expect(callMock).toHaveBeenCalledWith("git_rename_branch", {
      repoPath: "/r",
      old: "old",
      newName: "new",
    })
  })

  it("network ops", async () => {
    await gitFetch("/r", "origin", true)
    expect(callMock).toHaveBeenCalledWith("git_fetch", {
      repoPath: "/r",
      remote: "origin",
      prune: true,
    })
    await gitPull("/r", { rebase: true })
    expect(callMock).toHaveBeenCalledWith("git_pull", {
      repoPath: "/r",
      remote: null,
      branch: null,
      rebase: true,
    })
    await gitPush("/r", { setUpstream: true, branch: "main", remote: "origin" })
    expect(callMock).toHaveBeenCalledWith("git_push", {
      repoPath: "/r",
      remote: "origin",
      branch: "main",
      setUpstream: true,
      forceWithLease: false,
    })
    callMock.mockResolvedValueOnce({ ahead: 1, behind: 2 })
    expect(await gitSync("/r")).toEqual({ ahead: 1, behind: 2 })
  })

  it("stash ops", async () => {
    await gitStashPush("/r", { message: "wip", includeUntracked: true })
    expect(callMock).toHaveBeenCalledWith("git_stash_push", {
      repoPath: "/r",
      message: "wip",
      includeUntracked: true,
      keepIndex: false,
    })
    await gitStashPop("/r", 0)
    expect(callMock).toHaveBeenCalledWith("git_stash_pop", { repoPath: "/r", index: 0 })
    await gitStashApply("/r", 1)
    expect(callMock).toHaveBeenCalledWith("git_stash_apply", { repoPath: "/r", index: 1 })
    await gitStashDrop("/r", 2)
    expect(callMock).toHaveBeenCalledWith("git_stash_drop", { repoPath: "/r", index: 2 })
  })

  it("conflict resolution + abort + watcher", async () => {
    await gitResolveConflict("/r", "a", { side: "ours" })
    expect(callMock).toHaveBeenCalledWith("git_resolve_conflict", {
      repoPath: "/r",
      path: "a",
      mergedContent: null,
      side: "ours",
    })
    await gitResolveConflict("/r", "a", { mergedContent: "merged" })
    expect(callMock).toHaveBeenCalledWith("git_resolve_conflict", {
      repoPath: "/r",
      path: "a",
      mergedContent: "merged",
      side: null,
    })
    await gitMergeAbort("/r")
    expect(callMock).toHaveBeenCalledWith("git_merge_abort", { repoPath: "/r" })
    await gitWatchStart("/r")
    expect(callMock).toHaveBeenCalledWith("git_watch_start", { repoPath: "/r" })
    await gitWatchStop("/r")
    expect(callMock).toHaveBeenCalledWith("git_watch_stop", { repoPath: "/r" })
  })
})
