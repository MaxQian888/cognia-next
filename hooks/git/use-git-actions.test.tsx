jest.mock("@/lib/git/commands", () => ({
  gitStage: jest.fn(),
  gitUnstage: jest.fn(),
  gitDiscard: jest.fn(),
  gitDiscardAll: jest.fn(),
  gitCommit: jest.fn(),
  gitCheckoutBranch: jest.fn(),
  gitCreateBranch: jest.fn(),
  gitDeleteBranch: jest.fn(),
  gitRenameBranch: jest.fn(),
  gitFetch: jest.fn(),
  gitPull: jest.fn(),
  gitPush: jest.fn(),
  gitSync: jest.fn(),
  gitStashPush: jest.fn(),
  gitStashPop: jest.fn(),
  gitStashApply: jest.fn(),
  gitStashDrop: jest.fn(),
  gitResolveConflict: jest.fn(),
  gitMergeAbort: jest.fn(),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { act, renderHook } from "@testing-library/react"
import { toast } from "sonner"
import * as commandsNs from "@/lib/git/commands"
import { useGitActions } from "./use-git-actions"
import { useGitStore } from "@/stores/git/git-store"

const commands = commandsNs as jest.Mocked<typeof commandsNs>
const toastErrorMock = toast.error as jest.Mock
const refresh = jest.fn().mockResolvedValue(undefined)

beforeEach(() => {
  Object.values(commands).forEach((m) => {
    if (typeof m === "function") (m as jest.Mock).mockReset().mockResolvedValue(undefined)
  })
  toastErrorMock.mockReset()
  refresh.mockClear()
  act(() => {
    useGitStore.setState({ rootDir: "/repo" })
    useGitStore.getState().setStatus({
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [],
      changes: [],
      merge: [],
      isRebasing: false,
      isMerging: false,
    })
  })
})

describe("useGitActions", () => {
  it("stage sets the op flag, calls backend, then refreshes", async () => {
    commands.gitStage.mockImplementation(async () => {
      expect(useGitStore.getState().ops.stage).toBe(true)
    })
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.stage(["a.ts"])
    })
    expect(commands.gitStage).toHaveBeenCalledWith("/repo", ["a.ts"], undefined)
    expect(refresh).toHaveBeenCalled()
    expect(useGitStore.getState().ops.stage).toBe(false)
  })

  it("commit forwards flags", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.commit("msg", { amend: true, signoff: true })
    })
    expect(commands.gitCommit).toHaveBeenCalledWith("/repo", "msg", true, true)
  })

  it("push with setUpstream targets origin + current branch", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.push(true)
    })
    expect(commands.gitPush).toHaveBeenCalledWith("/repo", {
      setUpstream: true,
      branch: "main",
      remote: "origin",
    })
  })

  it("records error + toasts on failure, still resets the op flag", async () => {
    commands.gitPush.mockRejectedValue({ kind: "authRequired", detail: "no creds" })
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.push()
    })
    expect(useGitStore.getState().lastError).toEqual({ op: "push", message: "no creds" })
    expect(toastErrorMock).toHaveBeenCalled()
    expect(useGitStore.getState().ops.push).toBe(false)
  })

  it("no-ops when no repo is bound", async () => {
    act(() => useGitStore.setState({ rootDir: null }))
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.fetch()
    })
    expect(commands.gitFetch).not.toHaveBeenCalled()
  })

  it("resolveConflict forwards resolution", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.resolveConflict("a", { side: "ours" })
    })
    expect(commands.gitResolveConflict).toHaveBeenCalledWith("/repo", "a", { side: "ours" })
  })
})
