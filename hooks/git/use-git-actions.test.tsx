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
  gitIgnoreAdd: jest.fn(),
  gitMerge: jest.fn(),
  gitMergeAbort: jest.fn(),
  gitRestore: jest.fn(),
  gitCreateTag: jest.fn(),
  gitDeleteTag: jest.fn(),
  gitPushTag: jest.fn(),
  gitRemoteAdd: jest.fn(),
  gitRemoteRemove: jest.fn(),
  gitReset: jest.fn(),
  gitRebase: jest.fn(),
  gitCherryPick: jest.fn(),
  gitRevert: jest.fn(),
  gitSequencerContinue: jest.fn(),
  gitSequencerAbort: jest.fn(),
  gitInteractiveRebase: jest.fn(),
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

  it("unstage sets its own op flag, not 'stage'", async () => {
    commands.gitUnstage.mockImplementation(async () => {
      expect(useGitStore.getState().ops.unstage).toBe(true)
      expect(useGitStore.getState().ops.stage).toBe(false)
    })
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.unstage(["a.ts"])
    })
    expect(commands.gitUnstage).toHaveBeenCalledWith("/repo", ["a.ts"], undefined)
    expect(useGitStore.getState().ops.unstage).toBe(false)
  })

  it("restore sets its own op flag, not 'discard'", async () => {
    commands.gitRestore.mockImplementation(async () => {
      expect(useGitStore.getState().ops.restore).toBe(true)
      expect(useGitStore.getState().ops.discard).toBe(false)
    })
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.restore(["a.ts"], false, "HEAD~1")
    })
    expect(commands.gitRestore).toHaveBeenCalledWith("/repo", ["a.ts"], false, "HEAD~1")
    expect(useGitStore.getState().ops.restore).toBe(false)
  })

  it("commit forwards flags", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.commit("msg", { amend: true, signoff: true })
    })
    expect(commands.gitCommit).toHaveBeenCalledWith("/repo", "msg", true, true)
  })

  it("push with setUpstream sends the current branch and lets the backend resolve the remote", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.push({ setUpstream: true })
    })
    expect(commands.gitPush).toHaveBeenCalledWith("/repo", {
      setUpstream: true,
      forceWithLease: undefined,
      branch: "main",
    })
  })

  it("push with forceWithLease threads the flag without setting upstream", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.push({ forceWithLease: true })
    })
    expect(commands.gitPush).toHaveBeenCalledWith("/repo", {
      setUpstream: undefined,
      forceWithLease: true,
      branch: undefined,
    })
  })

  it("pull threads the rebase option", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.pull({ rebase: true })
    })
    expect(commands.gitPull).toHaveBeenCalledWith("/repo", { rebase: true })
  })

  it("fetch threads the prune option", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.fetch({ prune: true })
    })
    expect(commands.gitFetch).toHaveBeenCalledWith("/repo", undefined, true)
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

  it("toasts instead of silently no-opping when no repo is bound", async () => {
    act(() => useGitStore.setState({ rootDir: null }))
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.fetch()
    })
    expect(commands.gitFetch).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalled()
  })

  it("merge runs under the sequence op and forwards the branch", async () => {
    commands.gitMerge.mockImplementation(async () => {
      expect(useGitStore.getState().ops.sequence).toBe(true)
    })
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.merge("feature")
    })
    expect(commands.gitMerge).toHaveBeenCalledWith("/repo", "feature")
    expect(refresh).toHaveBeenCalled()
    expect(useGitStore.getState().ops.sequence).toBe(false)
  })

  it("ignoreAdd runs under the ignore op and forwards the pattern", async () => {
    commands.gitIgnoreAdd.mockImplementation(async () => {
      expect(useGitStore.getState().ops.ignore).toBe(true)
    })
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.ignoreAdd("dist/")
    })
    expect(commands.gitIgnoreAdd).toHaveBeenCalledWith("/repo", "dist/")
    expect(useGitStore.getState().ops.ignore).toBe(false)
  })

  it("resolveConflict forwards resolution", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.resolveConflict("a", { side: "ours" })
    })
    expect(commands.gitResolveConflict).toHaveBeenCalledWith("/repo", "a", { side: "ours" })
  })

  it("forwards the remaining thin wrappers to their commands", async () => {
    const { result } = renderHook(() => useGitActions(refresh))
    await act(async () => {
      await result.current.discard(["a.ts"])
      await result.current.discardAll(true)
      await result.current.checkout("dev")
      await result.current.createBranch("b", true, "abc")
      await result.current.deleteBranch("b", false)
      await result.current.renameBranch("b2", "b")
      await result.current.pull()
      await result.current.sync()
      await result.current.stashPush({ message: "wip" })
      await result.current.stashPop(0)
      await result.current.stashApply(1)
      await result.current.stashDrop(2)
      await result.current.mergeAbort()
      await result.current.remoteAdd("origin", "https://e.com/r.git")
      await result.current.remoteRemove("origin")
      await result.current.createTag("v1", "msg", "abc")
      await result.current.deleteTag("v1")
      await result.current.pushTag("v1")
      await result.current.reset("soft", "HEAD~1")
      await result.current.rebase("main")
      await result.current.cherryPick("abc")
      await result.current.revert("abc")
      await result.current.sequencerContinue()
      await result.current.sequencerAbort()
      await result.current.interactiveRebase("base", [])
    })
    expect(commands.gitDiscard).toHaveBeenCalledWith("/repo", ["a.ts"], undefined)
    expect(commands.gitDiscardAll).toHaveBeenCalledWith("/repo", true)
    expect(commands.gitCheckoutBranch).toHaveBeenCalledWith("/repo", "dev")
    expect(commands.gitCreateBranch).toHaveBeenCalledWith("/repo", "b", true, "abc")
    expect(commands.gitDeleteBranch).toHaveBeenCalledWith("/repo", "b", false)
    expect(commands.gitRenameBranch).toHaveBeenCalledWith("/repo", "b2", "b")
    expect(commands.gitPull).toHaveBeenCalledWith("/repo", { rebase: false })
    expect(commands.gitSync).toHaveBeenCalledWith("/repo")
    expect(commands.gitStashPush).toHaveBeenCalledWith("/repo", { message: "wip" })
    expect(commands.gitStashPop).toHaveBeenCalledWith("/repo", 0)
    expect(commands.gitStashApply).toHaveBeenCalledWith("/repo", 1)
    expect(commands.gitStashDrop).toHaveBeenCalledWith("/repo", 2)
    expect(commands.gitMergeAbort).toHaveBeenCalledWith("/repo")
    expect(commands.gitRemoteAdd).toHaveBeenCalledWith("/repo", "origin", "https://e.com/r.git")
    expect(commands.gitRemoteRemove).toHaveBeenCalledWith("/repo", "origin")
    expect(commands.gitCreateTag).toHaveBeenCalledWith("/repo", "v1", "msg", "abc")
    expect(commands.gitDeleteTag).toHaveBeenCalledWith("/repo", "v1")
    expect(commands.gitPushTag).toHaveBeenCalledWith("/repo", "v1", undefined)
    expect(commands.gitReset).toHaveBeenCalledWith("/repo", "soft", "HEAD~1")
    expect(commands.gitRebase).toHaveBeenCalledWith("/repo", "main")
    expect(commands.gitCherryPick).toHaveBeenCalledWith("/repo", "abc")
    expect(commands.gitRevert).toHaveBeenCalledWith("/repo", "abc")
    expect(commands.gitSequencerContinue).toHaveBeenCalledWith("/repo")
    expect(commands.gitSequencerAbort).toHaveBeenCalledWith("/repo")
    expect(commands.gitInteractiveRebase).toHaveBeenCalledWith("/repo", "base", [])
  })
})
