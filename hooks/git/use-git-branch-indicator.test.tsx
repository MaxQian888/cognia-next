jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/git/commands", () => ({
  gitWatchStart: jest.fn(),
  gitWatchStop: jest.fn(),
}))
jest.mock("@/lib/git/events", () => ({ subscribeGitStatusChanged: jest.fn() }))
jest.mock("@/lib/git/load", () => ({
  loadGitRepo: jest.fn(),
  refreshGitStatus: jest.fn(),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { isTauri } from "@/lib/tauri"
import { gitWatchStart, gitWatchStop } from "@/lib/git/commands"
import { subscribeGitStatusChanged } from "@/lib/git/events"
import { loadGitRepo, refreshGitStatus } from "@/lib/git/load"
import { useGitBranchIndicator } from "./use-git-branch-indicator"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"

const isTauriMock = isTauri as jest.Mock
const watchStartMock = gitWatchStart as jest.Mock
const watchStopMock = gitWatchStop as jest.Mock
const subscribeMock = subscribeGitStatusChanged as jest.Mock
const loadGitRepoMock = loadGitRepo as jest.Mock
const refreshGitStatusMock = refreshGitStatus as jest.Mock

let eventHandler: ((e: { rootDir: string }) => void) | null = null

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  loadGitRepoMock.mockReset().mockResolvedValue(undefined)
  refreshGitStatusMock.mockReset().mockResolvedValue(undefined)
  watchStartMock.mockReset().mockResolvedValue(undefined)
  watchStopMock.mockReset().mockResolvedValue(undefined)
  eventHandler = null
  subscribeMock.mockReset().mockImplementation((cb: (e: { rootDir: string }) => void) => {
    eventHandler = cb
    return jest.fn()
  })
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
        projects: [{ id: "p1", rootDir: "/proj" } as never],
      })
    })
    renderHook(() => useGitBranchIndicator())
    await waitFor(() => expect(useGitStore.getState().rootDir).toBe("/proj"))
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

  it("is inert on web", async () => {
    isTauriMock.mockReturnValue(false)
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    renderHook(() => useGitBranchIndicator())
    await Promise.resolve()
    expect(watchStartMock).not.toHaveBeenCalled()
  })
})
