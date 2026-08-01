const gitRepoStateMock = jest.fn()
const gitStatusMock = jest.fn()
const gitBranchesMock = jest.fn()
const gitStashListMock = jest.fn()
const gitConflictsMock = jest.fn()

jest.mock("@/lib/git/commands", () => ({
  gitRepoState: (...a: unknown[]) => gitRepoStateMock(...a),
  gitStatus: (...a: unknown[]) => gitStatusMock(...a),
  gitBranches: (...a: unknown[]) => gitBranchesMock(...a),
  gitStashList: (...a: unknown[]) => gitStashListMock(...a),
  gitConflicts: (...a: unknown[]) => gitConflictsMock(...a),
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
  gitBranchesMock.mockReset()
  gitStashListMock.mockReset()
  gitConflictsMock.mockReset()
  useGitStore.getState().reset()
  useGitStore.setState({ rootDir: "/r" })
})

describe("loadGitRepo", () => {
  it("clears state when rootDir is null", async () => {
    await loadGitRepo(null)
    expect(useGitStore.getState().status).toBeNull()
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
})

describe("refreshGitStatus", () => {
  it("updates status + conflicts only", async () => {
    gitRepoStateMock.mockResolvedValue(repoState)
    gitStatusMock.mockResolvedValue(status("dev"))
    gitConflictsMock.mockResolvedValue([{ path: "a" }])
    await refreshGitStatus("/r")
    expect(useGitStore.getState().status?.branch).toBe("dev")
    expect(useGitStore.getState().conflicts).toHaveLength(1)
    expect(gitBranchesMock).not.toHaveBeenCalled()
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
