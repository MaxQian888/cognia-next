const isTauriMock = jest.fn()
const isCapacitorMock = jest.fn()
const hasWebCompanionTargetMock = jest.fn()
const callMock = jest.fn()
const subscribeMock = jest.fn()

jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => isTauriMock(),
  isCapacitor: () => isCapacitorMock(),
}))

jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => hasWebCompanionTargetMock(),
}))

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
  gitCherryPick,
  gitCommit,
  gitCommitFiles,
  gitConflicts,
  gitCreateBranch,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteTag,
  gitDiffCommit,
  gitDiffFile,
  gitDiffStagedAll,
  gitDiffStat,
  gitDiffRefsFile,
  gitDiffRefsFiles,
  gitDiscard,
  gitDiscardAll,
  gitFetch,
  gitFileHistory,
  gitBlame,
  gitIgnoreAdd,
  gitInit,
  gitIsRepo,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitInteractiveRebase,
  gitPull,
  gitPush,
  gitPushTag,
  gitRebase,
  gitRebaseCommits,
  gitRefs,
  gitRemoteAdd,
  gitRemoteRemove,
  gitRemotes,
  gitRenameBranch,
  gitRepoState,
  gitReset,
  gitRestore,
  gitRevert,
  gitResolveConflict,
  gitSequencerAbort,
  gitSequencerContinue,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatus,
  gitSync,
  gitTags,
  gitUnstage,
  gitWatchStart,
  gitWatchStop,
  gitWorktreeAdd,
  gitWorktreeCommit,
  gitWorktreeList,
  gitWorktreePrune,
  gitWorktreeRemove,
  hasGitBridge,
} from "./commands"
import { EMPTY_REPO_STATE, EMPTY_STATUS } from "@/types/git"

beforeEach(() => {
  isTauriMock.mockReset()
  isCapacitorMock.mockReset()
  hasWebCompanionTargetMock.mockReset()
  isCapacitorMock.mockReturnValue(false)
  hasWebCompanionTargetMock.mockReturnValue(false)
  callMock.mockReset()
  subscribeMock.mockReset()
})

describe("when no git bridge is available (plain unpaired browser)", () => {
  beforeEach(() => isTauriMock.mockReturnValue(false))

  it("returns inert values without calling transport", async () => {
    expect(await gitIsRepo("/r")).toBe(false)
    expect(await gitRepoState("/r")).toBe(EMPTY_REPO_STATE)
    expect(await gitStatus("/r")).toBe(EMPTY_STATUS)
    expect(await gitDiffStat("/r")).toEqual([])
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
    expect(await gitWorktreeList("/r")).toEqual([])
    expect(await gitWorktreeCommit("/wt", "m")).toBeNull()
    await gitWorktreeAdd("/r", "/wt", "agent/x")
    await gitWorktreeRemove("/r", "/wt", true, "agent/x")
    await gitWorktreePrune("/r")
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe("when on a companion transport (Capacitor / paired web)", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false)
    isCapacitorMock.mockReturnValue(true)
    callMock.mockResolvedValue(undefined)
  })

  it("reads and writes go through the transport", async () => {
    callMock.mockResolvedValueOnce(true)
    expect(await gitIsRepo("/r")).toBe(true)
    expect(callMock).toHaveBeenCalledWith("git_is_repo", { repoPath: "/r" })

    await gitStage("/r", ["a.ts"])
    expect(callMock).toHaveBeenCalledWith("git_stage", {
      repoPath: "/r",
      paths: ["a.ts"],
      hunkPatch: null,
    })
  })

  it("the fs watcher stays Tauri-only", async () => {
    await gitWatchStart("/r")
    await gitWatchStop("/r")
    expect(callMock).not.toHaveBeenCalled()
  })

  it("hasGitBridge reflects the web-companion pairing too", () => {
    isCapacitorMock.mockReturnValue(false)
    expect(hasGitBridge()).toBe(false)
    hasWebCompanionTargetMock.mockReturnValue(true)
    expect(hasGitBridge()).toBe(true)
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

    callMock.mockResolvedValueOnce([{ path: "src/a.ts", insertions: 2, deletions: 1 }])
    await expect(gitDiffStat("/r")).resolves.toEqual([
      { path: "src/a.ts", insertions: 2, deletions: 1 },
    ])
    expect(callMock).toHaveBeenCalledWith("git_diff_stat", { repoPath: "/r" })

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

  it("covers the extended read and history command surface", async () => {
    const diff = { path: "a.ts", oldContent: "", newContent: "", hunks: [], isBinary: false }
    callMock.mockResolvedValueOnce(diff)
    expect((await gitDiffCommit("/r", "abc", "a.ts")).language).toBe("typescript")
    await gitCommitFiles("/r", "abc")
    await gitDiffStagedAll("/r")
    await gitRefs("/r")
    await gitBlame("/r", "a.ts", "HEAD")
    await gitRemotes("/r")
    await gitTags("/r")
    expect(callMock).toHaveBeenCalledWith("git_diff_commit", {
      repoPath: "/r",
      sha: "abc",
      path: "a.ts",
    })
    expect(callMock).toHaveBeenCalledWith("git_blame", {
      repoPath: "/r",
      path: "a.ts",
      rev: "HEAD",
    })
  })

  it("covers remote, tag, restore, and sequencer command surfaces", async () => {
    await gitRemoteAdd("/r", "upstream", "https://example.test/repo.git")
    await gitRemoteRemove("/r", "upstream")
    await gitCreateTag("/r", "v1", "release", "HEAD")
    await gitDeleteTag("/r", "v1")
    await gitPushTag("/r", "v1")
    await gitReset("/r", "mixed", "HEAD~1")
    await gitRestore("/r", ["a.ts"], true, "HEAD")
    await gitRebase("/r", "main")
    await gitCherryPick("/r", "abc")
    await gitRevert("/r", "def")
    await gitSequencerContinue("/r")
    await gitSequencerAbort("/r")
    await gitRebaseCommits("/r", "main")
    await gitInteractiveRebase("/r", "main", [{ action: "pick", sha: "abc" }])

    expect(callMock).toHaveBeenCalledWith("git_create_tag", {
      repoPath: "/r",
      name: "v1",
      message: "release",
      target: "HEAD",
    })
    expect(callMock).toHaveBeenCalledWith("git_restore", {
      repoPath: "/r",
      paths: ["a.ts"],
      staged: true,
      source: "HEAD",
    })
    expect(callMock).toHaveBeenCalledWith("git_interactive_rebase", {
      repoPath: "/r",
      base: "main",
      entries: [{ action: "pick", sha: "abc" }],
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

  it("worktree ops pass null defaults", async () => {
    await gitWorktreeAdd("/r", "/wt", "agent/run/alice/t1")
    expect(callMock).toHaveBeenCalledWith("git_worktree_add", {
      repoPath: "/r",
      path: "/wt",
      branch: "agent/run/alice/t1",
      baseRef: null,
    })
    await gitWorktreeAdd("/r", "/wt", "agent/b", "HEAD")
    expect(callMock).toHaveBeenCalledWith("git_worktree_add", {
      repoPath: "/r",
      path: "/wt",
      branch: "agent/b",
      baseRef: "HEAD",
    })
    await gitWorktreeRemove("/r", "/wt", true, "agent/b")
    expect(callMock).toHaveBeenCalledWith("git_worktree_remove", {
      repoPath: "/r",
      path: "/wt",
      force: true,
      deleteBranch: "agent/b",
    })
    await gitWorktreeRemove("/r", "/wt", false)
    expect(callMock).toHaveBeenCalledWith("git_worktree_remove", {
      repoPath: "/r",
      path: "/wt",
      force: false,
      deleteBranch: null,
    })
    callMock.mockResolvedValueOnce([{ path: "/r", branch: "main", head: "abc", isMain: true }])
    const wts = await gitWorktreeList("/r")
    expect(callMock).toHaveBeenCalledWith("git_worktree_list", { repoPath: "/r" })
    expect(wts[0]?.isMain).toBe(true)

    callMock.mockResolvedValueOnce("sha123")
    const sha = await gitWorktreeCommit("/wt", "agent work")
    expect(callMock).toHaveBeenCalledWith("git_worktree_commit", {
      worktreePath: "/wt",
      message: "agent work",
    })
    expect(sha).toBe("sha123")

    await gitWorktreePrune("/r")
    expect(callMock).toHaveBeenCalledWith("git_worktree_prune", { repoPath: "/r" })
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
    await gitInit("/dir")
    expect(callMock).toHaveBeenCalledWith("git_init", { path: "/dir" })
    callMock.mockResolvedValueOnce([])
    await gitDiffRefsFiles("/r", "main", "feature")
    expect(callMock).toHaveBeenCalledWith("git_diff_refs_files", {
      repoPath: "/r",
      base: "main",
      target: "feature",
    })
    callMock.mockResolvedValueOnce({
      path: "a.ts",
      oldContent: "",
      newContent: "",
      hunks: [],
      isBinary: false,
    })
    await gitDiffRefsFile("/r", "main", "feature", "a.ts")
    expect(callMock).toHaveBeenCalledWith("git_diff_refs_file", {
      repoPath: "/r",
      base: "main",
      target: "feature",
      path: "a.ts",
    })
    await gitIgnoreAdd("/r", "dist/")
    expect(callMock).toHaveBeenCalledWith("git_ignore_add", { repoPath: "/r", pattern: "dist/" })
    await gitMerge("/r", "feature")
    expect(callMock).toHaveBeenCalledWith("git_merge", { repoPath: "/r", branch: "feature" })
    await gitMergeAbort("/r")
    expect(callMock).toHaveBeenCalledWith("git_merge_abort", { repoPath: "/r" })
    await gitWatchStart("/r")
    expect(callMock).toHaveBeenCalledWith("git_watch_start", { repoPath: "/r" })
    await gitWatchStop("/r")
    expect(callMock).toHaveBeenCalledWith("git_watch_stop", { repoPath: "/r" })
  })
})
