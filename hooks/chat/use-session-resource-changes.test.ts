/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import {
  installTaskWorkspaceEventListener,
  listTaskResources,
  listTaskWorkspaces,
} from "@/lib/task-workspace/client"
import type { ResourceChange } from "@/lib/task-workspace/types"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"

import { summarizeResourceChanges, useSessionResourceChanges } from "./use-session-resource-changes"

jest.mock("@/lib/files/workspace-backend", () => ({ hasWorkspaceFsBackend: jest.fn(() => true) }))
jest.mock("@/lib/task-workspace/client", () => ({
  installTaskWorkspaceEventListener: jest.fn(),
  listTaskResources: jest.fn(),
  listTaskWorkspaces: jest.fn(),
}))

function change(path: string, insertions: number | null, deletions: number | null) {
  return { runId: "r1", path, kind: "modified", insertions, deletions } as ResourceChange
}

beforeEach(() => {
  jest.mocked(hasWorkspaceFsBackend).mockReturnValue(true)
  jest.mocked(installTaskWorkspaceEventListener).mockReset().mockResolvedValue(jest.fn())
  jest.mocked(listTaskWorkspaces).mockReset().mockResolvedValue([])
  jest.mocked(listTaskResources).mockReset().mockResolvedValue([])
  useTaskWorkspaceStore.setState({ activeBySession: {}, resourcesByTask: {}, provisionalByRun: {} })
})

describe("summarizeResourceChanges", () => {
  it("sums known line counts", () => {
    expect(summarizeResourceChanges([change("a", 3, 1), change("b", 10, 0)])).toEqual({
      files: 2,
      insertions: 13,
      deletions: 1,
      linesKnown: true,
    })
  })

  it("marks the totals unknown when any file has no counts", () => {
    expect(summarizeResourceChanges([change("a", 3, 1), change("img.png", null, null)])).toEqual({
      files: 2,
      insertions: 3,
      deletions: 1,
      linesKnown: false,
    })
  })

  it("reports zero files for no data", () => {
    expect(summarizeResourceChanges(undefined)).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
      linesKnown: true,
    })
  })
})

describe("useSessionResourceChanges", () => {
  it("lists every workspace bound to the session and totals the lines", async () => {
    jest.mocked(listTaskWorkspaces).mockResolvedValue([
      { taskId: "t1", sessionId: "s1" },
      { taskId: "t-other", sessionId: "s2" },
    ] as never)
    jest.mocked(listTaskResources).mockResolvedValue([change("a.ts", 4, 2)])
    const { result } = renderHook(() => useSessionResourceChanges("s1"))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(listTaskResources).toHaveBeenCalledTimes(1)
    expect(listTaskResources).toHaveBeenCalledWith("t1")
    expect(result.current.tracked).toBe(true)
    expect(result.current.totals).toEqual({
      files: 1,
      insertions: 4,
      deletions: 2,
      linesKnown: true,
    })
  })

  it("reports a failed listing and recovers on retry", async () => {
    jest.mocked(listTaskWorkspaces).mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useSessionResourceChanges("s1"))
    await waitFor(() => expect(result.current.failed).toBe(true))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.failed).toBe(false))
    expect(result.current.settled).toBe(true)
    expect(result.current.tracked).toBe(false)
  })

  it("does nothing on a host without a workspace backend", () => {
    jest.mocked(hasWorkspaceFsBackend).mockReturnValue(false)
    const { result } = renderHook(() => useSessionResourceChanges("s1"))
    expect(result.current).toMatchObject({ available: false, loading: false, failed: false })
    expect(listTaskWorkspaces).not.toHaveBeenCalled()
    expect(installTaskWorkspaceEventListener).not.toHaveBeenCalled()
  })

  it("lists nothing for a surface with no conversation", () => {
    const { result } = renderHook(() => useSessionResourceChanges(null))
    expect(result.current).toMatchObject({ available: false, loading: false, tracked: false })
    expect(result.current.totals.files).toBe(0)
    expect(listTaskWorkspaces).not.toHaveBeenCalled()
    expect(installTaskWorkspaceEventListener).not.toHaveBeenCalled()
  })

  it("shows the cached list for the active run while the refresh is in flight", () => {
    jest.mocked(listTaskWorkspaces).mockReturnValue(new Promise(() => {}))
    useTaskWorkspaceStore.setState({
      activeBySession: { s1: { taskId: "t1", runId: "r1", state: "running" } as never },
      resourcesByTask: { t1: [change("cached.ts", 1, 1)] },
    })
    const { result } = renderHook(() => useSessionResourceChanges("s1"))
    expect(result.current.loading).toBe(false)
    expect(result.current.resources?.map((r) => r.path)).toEqual(["cached.ts"])
    expect(result.current.tracked).toBe(true)
  })
})
