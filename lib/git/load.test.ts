const gitRepoStateMock = jest.fn()
const gitStatusMock = jest.fn()
const gitBranchesMock = jest.fn()
const gitStashListMock = jest.fn()
const gitConflictsMock = jest.fn()
const gitWorktreeListMock = jest.fn()
const gitStackParentsMock = jest.fn()
const getGitOperationAvailabilityMock = jest.fn()

jest.mock("@/lib/git/commands", () => ({
  gitRepoState: (...a: unknown[]) => gitRepoStateMock(...a),
  gitStatus: (...a: unknown[]) => gitStatusMock(...a),
  gitBranches: (...a: unknown[]) => gitBranchesMock(...a),
  gitStashList: (...a: unknown[]) => gitStashListMock(...a),
  gitConflicts: (...a: unknown[]) => gitConflictsMock(...a),
  gitWorktreeList: (...a: unknown[]) => gitWorktreeListMock(...a),
  gitStackParents: (...a: unknown[]) => gitStackParentsMock(...a),
  getGitOperationAvailability: (...a: unknown[]) => getGitOperationAvailabilityMock(...a),
}))

import { loadGitRepo, refreshGitStatus } from "./load"
import { useGitStore } from "@/stores/git/git-store"
import type { GitStatus } from "@/types/git"

const repoState = { isRepo: true, rootDir: "/r", detachedHead: false, operationInProgress: null }

function status(branch: string): GitStatus {
  return {
    branch,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    merge: [],
    isRebasing: false,
    isMerging: false,
  }
}

beforeEach(() => {
  gitRepoStateMock.mockReset()
  gitStatusMock.mockReset()
  gitBranchesMock.mockReset().mockResolvedValue([])
  gitStashListMock.mockReset().mockResolvedValue([])
  gitConflictsMock.mockReset().mockResolvedValue([])
  gitWorktreeListMock.mockReset().mockResolvedValue([])
  gitStackParentsMock.mockReset().mockResolvedValue([])
  getGitOperationAvailabilityMock.mockReset().mockReturnValue({ state: "available" })
  useGitStore.getState().reset()
  useGitStore.setState({ rootDir: "/r" })
})

describe("loadGitRepo", () => {
  it("clears state when rootDir is null", async () => {
    useGitStore.setState({
      branches: [{ name: "stale" }] as never,
      stashes: [{ index: 0 }] as never,
      conflicts: [{ path: "stale" }] as never,
    })
    await loadGitRepo(null)
    expect(useGitStore.getState().status).toBeNull()
    expect(useGitStore.getState().branches).toEqual([])
    expect(useGitStore.getState().stashes).toEqual([])
    expect(useGitStore.getState().conflicts).toEqual([])
    expect(gitRepoStateMock).not.toHaveBeenCalled()
  })

  it("loads full state for a repo", async () => {
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock.mockResolvedValue(status("main"))
    gitBranchesMock.mockResolvedValue([{ name: "main" }])
    gitStashListMock.mockResolvedValue([{ index: 0 }])
    gitConflictsMock.mockResolvedValue([])

    await loadGitRepo("/r")
    expect(useGitStore.getState().repoState).toEqual(repoState)
    expect(useGitStore.getState().status?.branch).toBe("main")
    expect(useGitStore.getState().branches).toHaveLength(1)
    expect(useGitStore.getState().stashes).toHaveLength(1)
    expect(useGitStore.getState().loadingStatus).toBe(false)
  })

  it("loads worktrees and stack parents alongside the branch list", async () => {
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock.mockResolvedValue(status("main"))
    gitWorktreeListMock.mockResolvedValue([{ path: "/r/wt/a", branch: "a" }])
    gitStackParentsMock.mockResolvedValue([["b", "a"]])

    await loadGitRepo("/r")

    expect(useGitStore.getState().worktrees).toHaveLength(1)
    expect(useGitStore.getState().stackParents).toEqual([["b", "a"]])
  })

  /**
   * The annotating reads sit outside the panel's own `Promise.all` on purpose.
   * `git_worktree_list` answered `contract_output_violation` on every
   * companion until its response schema was corrected, and it still will
   * against a host on the older contract. A rejection there must cost the
   * annotation, never the snapshot the whole panel is built on.
   */
  it("keeps the snapshot when the worktree read rejects", async () => {
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock.mockResolvedValue(status("main"))
    gitBranchesMock.mockResolvedValue([{ name: "main" }])
    gitWorktreeListMock.mockRejectedValue(new Error("contract_output_violation"))

    await expect(loadGitRepo("/r")).resolves.toBeUndefined()

    expect(useGitStore.getState().status?.branch).toBe("main")
    expect(useGitStore.getState().branches).toHaveLength(1)
    expect(useGitStore.getState().worktrees).toEqual([])
    expect(useGitStore.getState().loadError).toBeNull()
  })

  it("keeps the snapshot when the stack-parent read rejects", async () => {
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock.mockResolvedValue(status("main"))
    gitStackParentsMock.mockRejectedValue(new Error("nope"))

    await expect(loadGitRepo("/r")).resolves.toBeUndefined()

    expect(useGitStore.getState().status?.branch).toBe("main")
    expect(useGitStore.getState().stackParents).toEqual([])
    expect(useGitStore.getState().loadError).toBeNull()
  })

  it("does not call an unavailable worktree or stack operation", async () => {
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock.mockResolvedValue(status("main"))
    getGitOperationAvailabilityMock.mockImplementation((command: string) => ({
      state:
        command === "git_worktree_list" || command === "git_stack_parents"
          ? "unavailable"
          : "available",
    }))

    await loadGitRepo("/r")

    expect(gitWorktreeListMock).not.toHaveBeenCalled()
    expect(gitStackParentsMock).not.toHaveBeenCalled()
    expect(useGitStore.getState().worktrees).toEqual([])
    expect(useGitStore.getState().stackParents).toEqual([])
  })

  it("does not call an unavailable optional repository operation", async () => {
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock.mockResolvedValue(status("main"))
    getGitOperationAvailabilityMock.mockImplementation((command: string) => ({
      state: command === "git_branches" ? "unavailable" : "available",
    }))

    await loadGitRepo("/r")

    expect(gitBranchesMock).not.toHaveBeenCalled()
    expect(useGitStore.getState().branches).toEqual([])
  })

  it("skips status load when path is not a repo", async () => {
    gitRepoStateMock.mockResolvedValue({ ...repoState, isRepo: false })
    await loadGitRepo("/r")
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(useGitStore.getState().status).toBeNull()
  })

  it("resets loading flag even on error", async () => {
    gitRepoStateMock.mockRejectedValue(new Error("boom"))
    await expect(loadGitRepo("/r")).rejects.toThrow("boom")
    expect(useGitStore.getState().loadingStatus).toBe(false)
    expect(useGitStore.getState().loadError).toBe("boom")
  })

  it("uses a structured Git error detail", async () => {
    gitRepoStateMock.mockRejectedValue({ kind: "commandFailed", detail: "typed detail" })

    await expect(loadGitRepo("/r")).rejects.toEqual({
      kind: "commandFailed",
      detail: "typed detail",
    })

    expect(useGitStore.getState().loadError).toBe("typed detail")
  })

  it("stringifies a non-Error rejection", async () => {
    gitRepoStateMock.mockRejectedValue("offline")

    await expect(loadGitRepo("/r")).rejects.toBe("offline")

    expect(useGitStore.getState().loadError).toBe("offline")
  })

  it("does not let an older request overwrite a newer repository load", async () => {
    let resolveOld!: (value: typeof repoState) => void
    gitRepoStateMock
      .mockImplementationOnce(
        () => new Promise<typeof repoState>((resolve) => (resolveOld = resolve))
      )
      .mockResolvedValueOnce({ ...repoState, rootDir: "/new" })
    gitStatusMock.mockResolvedValue(status("new"))
    gitBranchesMock.mockResolvedValue([])
    gitStashListMock.mockResolvedValue([])
    gitConflictsMock.mockResolvedValue([])

    const oldLoad = loadGitRepo("/r")
    useGitStore.getState().setRootDir("/new")
    await loadGitRepo("/new")
    resolveOld(repoState)
    await oldLoad

    expect(useGitStore.getState().repoState?.rootDir).toBe("/new")
    expect(useGitStore.getState().status?.branch).toBe("new")
  })

  it("rebinds a nested workspace path to the discovered repository root", async () => {
    useGitStore.setState({ rootDir: "/r/packages/app" })
    gitRepoStateMock
      .mockResolvedValueOnce({ ...repoState, rootDir: "/r" })
      .mockResolvedValueOnce(repoState)
    gitStatusMock.mockResolvedValue(status("main"))
    gitBranchesMock.mockResolvedValue([])
    gitStashListMock.mockResolvedValue([])
    gitConflictsMock.mockResolvedValue([])

    await loadGitRepo("/r/packages/app")

    expect(useGitStore.getState().rootDir).toBe("/r")
    expect(gitStatusMock).toHaveBeenCalledWith("/r")
  })
})

describe("refreshGitStatus", () => {
  it("updates every mutable repository list", async () => {
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock.mockResolvedValue(status("dev"))
    gitConflictsMock.mockResolvedValue([{ path: "a" }])
    await refreshGitStatus("/r")
    expect(useGitStore.getState().status?.branch).toBe("dev")
    expect(useGitStore.getState().conflicts).toHaveLength(1)
    expect(gitBranchesMock).toHaveBeenCalledWith("/r")
    expect(gitStashListMock).toHaveBeenCalledWith("/r")
  })

  it("wins over an older full load for every mutable repository field", async () => {
    let resolveOldStatus!: (value: GitStatus) => void
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock
      .mockImplementationOnce(
        () => new Promise<GitStatus>((resolve) => (resolveOldStatus = resolve))
      )
      .mockResolvedValueOnce(status("dev"))
    gitBranchesMock
      .mockResolvedValueOnce([{ name: "old" }])
      .mockResolvedValueOnce([{ name: "dev" }])
    gitStashListMock.mockResolvedValue([])
    gitConflictsMock.mockResolvedValue([])

    const oldLoad = loadGitRepo("/r")
    // Let the full load consume the intentionally deferred first status call
    // before starting the newer watcher refresh.
    await Promise.resolve()
    await Promise.resolve()
    expect(gitStatusMock).toHaveBeenCalledTimes(1)
    await refreshGitStatus("/r")
    resolveOldStatus(status("old"))
    await oldLoad

    expect(useGitStore.getState().status?.branch).toBe("dev")
    expect(useGitStore.getState().branches).toEqual([{ name: "dev" }])
    expect(useGitStore.getState().loadingStatus).toBe(false)
  })

  it("rebinds a nested watcher path to the discovered repository root", async () => {
    useGitStore.setState({ rootDir: "/r/packages/app" })
    gitRepoStateMock
      .mockResolvedValueOnce({ ...repoState, rootDir: "/r" })
      .mockResolvedValueOnce(repoState)
    gitStatusMock.mockResolvedValue(status("main"))

    await refreshGitStatus("/r/packages/app")

    expect(useGitStore.getState().rootDir).toBe("/r")
    expect(gitStatusMock).toHaveBeenCalledWith("/r")
    expect(useGitStore.getState().loadingStatus).toBe(false)
  })

  it("clears mutable lists when the repository disappears", async () => {
    useGitStore.setState({
      status: status("main"),
      branches: [{ name: "main" }] as never,
      stashes: [{ index: 0 }] as never,
      conflicts: [{ path: "a.txt" }] as never,
    })
    gitRepoStateMock.mockResolvedValue({ ...repoState, isRepo: false, rootDir: null })

    await refreshGitStatus("/r")

    expect(useGitStore.getState().status).toBeNull()
    expect(useGitStore.getState().branches).toEqual([])
    expect(useGitStore.getState().stashes).toEqual([])
    expect(useGitStore.getState().conflicts).toEqual([])
  })

  it("records refresh errors for an inline retry without clearing existing status", async () => {
    useGitStore.getState().setStatus(status("main"))
    gitRepoStateMock.mockRejectedValue(new Error("offline"))

    await expect(refreshGitStatus("/r")).rejects.toThrow("offline")

    expect(useGitStore.getState().status?.branch).toBe("main")
    expect(useGitStore.getState().loadError).toBe("offline")
  })

  it("no-ops on null path", async () => {
    await refreshGitStatus(null)
    expect(gitRepoStateMock).not.toHaveBeenCalled()
  })
})
