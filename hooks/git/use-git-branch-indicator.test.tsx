jest.mock("@/lib/git/commands", () => ({
  gitWatchStart: jest.fn(),
  gitWatchStop: jest.fn(),
  isSourceControlUiAvailable: jest.fn(),
}))
jest.mock("@/lib/git/events", () => ({ subscribeGitStatusChanged: jest.fn() }))
jest.mock("@/lib/git/load", () => ({
  loadGitRepo: jest.fn(),
  refreshGitStatus: jest.fn(),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { gitWatchStart, gitWatchStop, isSourceControlUiAvailable } from "@/lib/git/commands"
import { subscribeGitStatusChanged } from "@/lib/git/events"
import { loadGitRepo, refreshGitStatus } from "@/lib/git/load"
import { useGitBranchIndicator, __resetGitIndicatorBinding } from "./use-git-branch-indicator"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"

const uiAvailableMock = isSourceControlUiAvailable as jest.Mock
const watchStartMock = gitWatchStart as jest.Mock
const watchStopMock = gitWatchStop as jest.Mock
const subscribeMock = subscribeGitStatusChanged as jest.Mock
const loadGitRepoMock = loadGitRepo as jest.Mock
const refreshGitStatusMock = refreshGitStatus as jest.Mock

let eventHandler: ((e: { rootDir: string }) => void) | null = null

beforeEach(() => {
  uiAvailableMock.mockReset().mockReturnValue(true)
  loadGitRepoMock.mockReset().mockResolvedValue(undefined)
  refreshGitStatusMock.mockReset().mockResolvedValue(undefined)
  watchStartMock.mockReset().mockResolvedValue(undefined)
  watchStopMock.mockReset().mockResolvedValue(undefined)
  eventHandler = null
  subscribeMock.mockReset().mockImplementation((cb: (e: { rootDir: string }) => void) => {
    eventHandler = cb
    return jest.fn()
  })
  __resetGitIndicatorBinding()
  act(() => {
    useGitStore.setState({ rootDir: null })
    useProjectStore.setState({ projects: [], activeProjectId: null })
  })
})

describe("useGitBranchIndicator", () => {
  it("seeds rootDir from the active project's rootDir", async () => {
    act(() => {
      useProjectStore.setState({
        activeProjectId: "p1",
        projects: [
          {
            id: "p1",
            roots: [{ id: "r1", path: "/proj", isPrimary: true }],
            rootDir: "/proj",
          } as never,
        ],
      })
    })
    renderHook(() => useGitBranchIndicator())
    await waitFor(() => expect(useGitStore.getState().rootDir).toBe("/proj"))
  })

  it("re-binds when the active workspace switches", async () => {
    act(() => {
      useProjectStore.setState({
        activeProjectId: "p1",
        projects: [
          {
            id: "p1",
            roots: [{ id: "r1", path: "/proj", isPrimary: true }],
            rootDir: "/proj",
          } as never,
        ],
      })
    })
    renderHook(() => useGitBranchIndicator())
    await waitFor(() => expect(useGitStore.getState().rootDir).toBe("/proj"))

    act(() => {
      useProjectStore.setState({
        activeProjectId: "p2",
        projects: [{ id: "p2", roots: [{ id: "r2", path: "/proj2", isPrimary: true }] } as never],
      })
    })
    await waitFor(() => expect(useGitStore.getState().rootDir).toBe("/proj2"))
  })

  it("binds to the primary root even when the rootDir mirror is absent", async () => {
    act(() => {
      useProjectStore.setState({
        activeProjectId: "p3",
        projects: [
          {
            id: "p3",
            roots: [
              { id: "r1", path: "/secondary" },
              { id: "r2", path: "/primary", isPrimary: true },
            ],
          } as never,
        ],
      })
    })
    renderHook(() => useGitBranchIndicator())
    await waitFor(() => expect(useGitStore.getState().rootDir).toBe("/primary"))
  })

  it("does not snap back to the workspace root after a manual git-panel rebind", async () => {
    act(() => {
      useProjectStore.setState({
        activeProjectId: "p1",
        projects: [
          {
            id: "p1",
            roots: [{ id: "r1", path: "/proj", isPrimary: true }],
            rootDir: "/proj",
          } as never,
        ],
      })
    })
    renderHook(() => useGitBranchIndicator())
    await waitFor(() => expect(useGitStore.getState().rootDir).toBe("/proj"))

    // User opens an ad-hoc repo in the panel; the workspace didn't change, so
    // the follow effect must leave the manual binding alone.
    act(() => useGitStore.getState().setRootDir("/adhoc"))
    await Promise.resolve()
    expect(useGitStore.getState().rootDir).toBe("/adhoc")
  })

  it("does not snap an ad-hoc binding back to the workspace root after a remount", async () => {
    act(() => {
      useProjectStore.setState({
        activeProjectId: "p1",
        projects: [
          {
            id: "p1",
            roots: [{ id: "r1", path: "/proj", isPrimary: true }],
            rootDir: "/proj",
          } as never,
        ],
      })
    })
    const first = renderHook(() => useGitBranchIndicator())
    await waitFor(() => expect(useGitStore.getState().rootDir).toBe("/proj"))

    // Manual rebind to an ad-hoc repo, then the always-mounted hook remounts
    // (route change / StrictMode). The workspace root is unchanged, so the
    // remount must NOT re-bind back to /proj.
    act(() => useGitStore.getState().setRootDir("/adhoc"))
    first.unmount()
    renderHook(() => useGitBranchIndicator())
    await Promise.resolve()
    expect(useGitStore.getState().rootDir).toBe("/adhoc")
  })

  it("leaves the binding untouched when the active workspace has no rootDir", async () => {
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    act(() => {
      useProjectStore.setState({
        activeProjectId: "p1",
        projects: [{ id: "p1" } as never],
      })
    })
    renderHook(() => useGitBranchIndicator())
    await Promise.resolve()
    expect(useGitStore.getState().rootDir).toBe("/repo")
  })

  it("owns the watcher and refreshes on a matching event", async () => {
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    renderHook(() => useGitBranchIndicator())
    await waitFor(() => expect(watchStartMock).toHaveBeenCalledWith("/repo"))
    expect(loadGitRepoMock).toHaveBeenCalledWith("/repo")

    act(() => eventHandler?.({ rootDir: "/repo" }))
    expect(refreshGitStatusMock).toHaveBeenCalledWith("/repo")

    refreshGitStatusMock.mockClear()
    act(() => eventHandler?.({ rootDir: "/other" }))
    expect(refreshGitStatusMock).not.toHaveBeenCalled()
  })

  it("stops the watcher on unmount", async () => {
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    const { unmount } = renderHook(() => useGitBranchIndicator())
    await waitFor(() => expect(watchStartMock).toHaveBeenCalled())
    unmount()
    expect(watchStopMock).toHaveBeenCalledWith("/repo")
  })

  it("exposes branch + busy from the store", () => {
    act(() => {
      useGitStore.setState({ rootDir: "/repo" })
      useGitStore.getState().setStatus({
        branch: "feature",
        upstream: "origin/feature",
        ahead: 3,
        behind: 1,
        staged: [],
        changes: [],
        merge: [],
        isRebasing: false,
        isMerging: false,
      })
      useGitStore.getState().setOp("sync", true)
    })
    const { result } = renderHook(() => useGitBranchIndicator())
    expect(result.current.branch).toBe("feature")
    expect(result.current.ahead).toBe(3)
    expect(result.current.busy).toBe(true)
  })

  it("is inert and matches the panel gate when the SC UI is unavailable", async () => {
    // Off the desktop the panel is unavailable; the chip must agree so a live
    // chip can never navigate to a dead panel.
    uiAvailableMock.mockReturnValue(false)
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    const { result } = renderHook(() => useGitBranchIndicator())
    await Promise.resolve()
    expect(result.current.available).toBe(false)
    expect(loadGitRepoMock).not.toHaveBeenCalled()
    expect(watchStartMock).not.toHaveBeenCalled()
    expect(subscribeMock).not.toHaveBeenCalled()
  })

  it("can observe the shared store without owning a native controller", async () => {
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    const { result } = renderHook(() => useGitBranchIndicator({ enabled: false }))
    await Promise.resolve()

    expect(result.current.available).toBe(false)
    expect(loadGitRepoMock).not.toHaveBeenCalled()
    expect(watchStartMock).not.toHaveBeenCalled()
    expect(subscribeMock).not.toHaveBeenCalled()
  })
})
