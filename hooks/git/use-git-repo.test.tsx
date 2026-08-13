const uiAvailableMock = jest.fn()
const loadGitRepoMock = jest.fn()
const openFolderAsWorkspaceMock = jest.fn()
const gitWorkspaceListMock = jest.fn()
const isTauriMock = jest.fn()

jest.mock("@/lib/git/commands", () => ({
  isSourceControlUiAvailable: () => uiAvailableMock(),
  gitWorkspaceList: () => gitWorkspaceListMock(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
jest.mock("@/lib/git/load", () => ({ loadGitRepo: (...a: unknown[]) => loadGitRepoMock(...a) }))
jest.mock("@/lib/workspace/open-folder", () => ({
  openFolderAsWorkspace: (...a: unknown[]) => openFolderAsWorkspaceMock(...a),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { useGitRepo } from "./use-git-repo"
import { useGitStore } from "@/stores/git/git-store"
import { gitTargetFromRemote } from "@/lib/git/target"

beforeEach(() => {
  uiAvailableMock.mockReset()
  loadGitRepoMock.mockReset().mockResolvedValue(undefined)
  openFolderAsWorkspaceMock.mockReset().mockResolvedValue(null)
  gitWorkspaceListMock.mockReset().mockResolvedValue([])
  isTauriMock.mockReset().mockReturnValue(true)
  act(() => useGitStore.setState({ rootDir: null }))
})

describe("useGitRepo", () => {
  it("loads on mount when a repo is bound (desktop)", async () => {
    uiAvailableMock.mockReturnValue(true)
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    renderHook(() => useGitRepo())
    await waitFor(() => expect(loadGitRepoMock).toHaveBeenCalledWith("/repo"))
  })

  it("safely consumes an initial load rejection", async () => {
    uiAvailableMock.mockReturnValue(true)
    loadGitRepoMock.mockRejectedValueOnce(new Error("repository unavailable"))
    act(() => useGitStore.setState({ rootDir: "/repo" }))

    renderHook(() => useGitRepo())

    await waitFor(() => expect(loadGitRepoMock).toHaveBeenCalledWith("/repo"))
    await act(async () => {
      await Promise.resolve()
    })
  })

  it("does not load on web", async () => {
    uiAvailableMock.mockReturnValue(false)
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    renderHook(() => useGitRepo())
    await Promise.resolve()
    expect(loadGitRepoMock).not.toHaveBeenCalled()
  })

  it("openFolder opens a folder as a workspace (indicator binds rootDir)", async () => {
    uiAvailableMock.mockReturnValue(true)
    openFolderAsWorkspaceMock.mockResolvedValue({ id: "p1" })
    const { result } = renderHook(() => useGitRepo())
    await act(async () => {
      await result.current.openFolder()
    })
    expect(openFolderAsWorkspaceMock).toHaveBeenCalledTimes(1)
    // The panel hook no longer sets rootDir directly — that is the git
    // indicator's job once the new workspace becomes active.
    expect(useGitStore.getState().rootDir).toBeNull()
  })

  it("refresh proxies to loadGitRepo for the bound path", async () => {
    uiAvailableMock.mockReturnValue(true)
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    const { result } = renderHook(() => useGitRepo())
    loadGitRepoMock.mockClear()
    await act(async () => {
      await result.current.refresh()
    })
    expect(loadGitRepoMock).toHaveBeenCalledWith("/repo")
  })

  it("discovers opaque remote workspaces and polls only while the surface is mounted", async () => {
    jest.useFakeTimers()
    uiAvailableMock.mockReturnValue(true)
    isTauriMock.mockReturnValue(false)
    gitWorkspaceListMock.mockResolvedValue([
      {
        workspaceId: "workspace-a",
        displayName: "Alpha",
        repositoryState: {
          isRepo: true,
          rootDir: "packages/app",
          detachedHead: false,
          operationInProgress: null,
        },
      },
    ])

    const { result, unmount } = renderHook(() => useGitRepo())
    await act(async () => {
      jest.advanceTimersByTime(0)
      await Promise.resolve()
    })
    expect(result.current.remoteWorkspaces).toHaveLength(1)
    expect(useGitStore.getState().rootDir).toBe(gitTargetFromRemote("workspace-a", "packages/app"))

    await act(async () => {
      jest.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(gitWorkspaceListMock).toHaveBeenCalledTimes(2)
    unmount()
    jest.advanceTimersByTime(5_000)
    expect(gitWorkspaceListMock).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it("drops a remote target that is no longer authorized", async () => {
    uiAvailableMock.mockReturnValue(true)
    isTauriMock.mockReturnValue(false)
    act(() => useGitStore.setState({ rootDir: gitTargetFromRemote("revoked", "repo") }))

    renderHook(() => useGitRepo())

    await waitFor(() => expect(useGitStore.getState().rootDir).toBeNull())
  })
})
