/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import type { Project } from "@/types"

const updateSession = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/sessions", () => ({ updateSession: (...a: unknown[]) => updateSession(...a) }))
const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

import { getExecutionBroker } from "@/lib/execution/broker"
import { useProjectStore } from "@/stores/project/project-store"
import {
  useMoveSessionWorkspace,
  useSessionWorkspaceMoveMenu,
  type MovableSession,
} from "./use-move-session-workspace"

const session: MovableSession = { id: "s1", projectId: "project-a" }

function seed(running = false) {
  jest.spyOn(getExecutionBroker(), "hasActiveSession").mockReturnValue(running)
  useProjectStore.setState({
    // `loaded` so `load()` is the no-op it is after boot.
    loaded: true,
    activeProjectId: "project-a",
    projects: [
      {
        id: "project-a",
        name: "Alpha",
        roots: [{ id: "ra", path: "/repos/a", isPrimary: true }],
        sessionIds: ["s1"],
      },
      {
        id: "project-b",
        name: "Beta",
        roots: [{ id: "rb", path: "/repos/b", isPrimary: true }],
        sessionIds: [],
      },
    ] as unknown as Project[],
  })
}

beforeEach(() => {
  updateSession.mockReset().mockResolvedValue(undefined)
  toastError.mockClear()
  toastSuccess.mockClear()
})

describe("useMoveSessionWorkspace", () => {
  it("writes the column, a context rebuilt for the destination, and both rosters", async () => {
    seed()
    const { result } = renderHook(() => useMoveSessionWorkspace())

    let moved = false
    await act(async () => {
      moved = await result.current.move(session, "project-b")
    })

    expect(moved).toBe(true)
    const [id, patch] = updateSession.mock.calls[0] as [
      string,
      { projectId: string; executionContext?: { projectRoot?: string } },
    ]
    expect(id).toBe("s1")
    expect(patch.projectId).toBe("project-b")
    expect(patch.executionContext?.projectRoot).toBe("/repos/b")
    const byId = Object.fromEntries(
      useProjectStore.getState().projects.map((project) => [project.id, project.sessionIds])
    )
    expect(byId["project-a"]).not.toContain("s1")
    expect(byId["project-b"]).toContain("s1")
    expect(toastSuccess).toHaveBeenCalledWith("Conversation moved")
  })

  it("hydrates the workspace store before it writes the rosters", async () => {
    seed()
    const order: string[] = []
    const hydrated = useProjectStore.getState()
    useProjectStore.setState({
      loaded: false,
      load: jest.fn(async () => {
        order.push("load")
        useProjectStore.setState({ loaded: true, load: hydrated.load })
      }),
    })
    updateSession.mockImplementation(async () => {
      order.push("write")
    })
    const { result } = renderHook(() => useMoveSessionWorkspace())

    await act(async () => {
      await result.current.move(session, "project-b")
    })

    expect(order).toEqual(["load", "write"])
  })

  it("refuses a running conversation and writes nothing", async () => {
    seed(true)
    const { result } = renderHook(() => useMoveSessionWorkspace())

    let moved = true
    await act(async () => {
      moved = await result.current.move(session, "project-b")
    })

    expect(moved).toBe(false)
    expect(updateSession).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it("reports a failed write and leaves the rosters alone", async () => {
    seed()
    updateSession.mockRejectedValueOnce(new Error("db closed"))
    const { result } = renderHook(() => useMoveSessionWorkspace())

    let moved = true
    await act(async () => {
      moved = await result.current.move(session, "project-b")
    })

    expect(moved).toBe(false)
    expect(String(toastError.mock.calls[0][0])).toContain("db closed")
    expect(
      useProjectStore.getState().projects.find((project) => project.id === "project-b")?.sessionIds
    ).toEqual([])
    expect(result.current.busy).toBe(false)
  })
})

describe("useSessionWorkspaceMoveMenu", () => {
  it("offers the unarchived workspaces and moves through the shared writer", async () => {
    seed()
    useProjectStore.setState((state) => ({
      projects: [
        ...state.projects,
        { id: "project-c", name: "Gone", roots: [], sessionIds: [], isArchived: true },
      ] as unknown as Project[],
    }))
    const { result } = renderHook(() => useSessionWorkspaceMoveMenu(session))
    expect(result.current.workspaceTargets.map((workspace) => workspace.id)).toEqual([
      "project-a",
      "project-b",
    ])
    expect(result.current.canMoveWorkspace).toBe(true)
    await act(async () => {
      result.current.onMoveWorkspace("project-b")
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(updateSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ projectId: "project-b" })
    )
  })

  it("has nowhere to move a conversation when its workspace is the only one", () => {
    seed()
    useProjectStore.setState((state) => ({ projects: state.projects.slice(0, 1) }))
    const { result } = renderHook(() => useSessionWorkspaceMoveMenu(session))
    expect(result.current.canMoveWorkspace).toBe(false)
  })
})
