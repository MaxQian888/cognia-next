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

// null = no Host takes the session, so the move is written on this device.
const enqueue = jest.fn(async (..._a: unknown[]): Promise<unknown> => null)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (...a: unknown[]) => enqueue(...a),
}))

// Folders the hook reads through `getDb().sessionFolders.get`; the rest of the
// schema module stays real.
const folderRows = new Map<string, { id: string; projectId?: string }>()
jest.mock("@/lib/db/schema", () => {
  const actual = jest.requireActual("@/lib/db/schema")
  return {
    ...actual,
    getDb: () => ({
      sessionFolders: { get: async (id: string) => folderRows.get(id) },
    }),
  }
})

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
  folderRows.clear()
  updateSession.mockReset().mockResolvedValue(undefined)
  enqueue.mockReset().mockResolvedValue(null)
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

  it("hands the move to the Host on a paired client and writes nothing here", async () => {
    seed()
    enqueue.mockResolvedValueOnce({ id: "job-1" })
    const { result } = renderHook(() => useMoveSessionWorkspace())

    let moved = false
    await act(async () => {
      moved = await result.current.move(session, "project-b")
    })

    expect(moved).toBe(true)
    expect(enqueue).toHaveBeenCalledWith({
      sessionId: "s1",
      action: { kind: "session.workspace", projectId: "project-b" },
    })
    expect(updateSession).not.toHaveBeenCalled()
    expect(
      useProjectStore.getState().projects.find((project) => project.id === "project-a")?.sessionIds
    ).toEqual(["s1"])
    expect(toastSuccess).toHaveBeenCalledWith("Sent to your Host, which will move the conversation")
    expect(result.current.busy).toBe(false)
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

  it("unfiles the conversation when its folder belongs to the old workspace", async () => {
    seed()
    folderRows.set("f-a", { id: "f-a", projectId: "project-a" })
    const { result } = renderHook(() => useMoveSessionWorkspace())

    await act(async () => {
      await result.current.move({ ...session, folderId: "f-a" }, "project-b")
    })

    const [, patch] = updateSession.mock.calls[0] as [string, Record<string, unknown>]
    expect(patch).toHaveProperty("folderId", undefined)
    expect("folderId" in patch).toBe(true)
  })

  it("keeps the folder when it can hold the conversation in its new workspace", async () => {
    seed()
    folderRows.set("f-any", { id: "f-any" })
    folderRows.set("f-b", { id: "f-b", projectId: "project-b" })
    const { result } = renderHook(() => useMoveSessionWorkspace())

    await act(async () => {
      await result.current.move({ ...session, folderId: "f-any" }, "project-b")
    })
    await act(async () => {
      await result.current.move({ ...session, folderId: "f-b" }, "project-b")
    })
    await act(async () => {
      await result.current.move({ ...session, folderId: "f-missing" }, "project-b")
    })

    expect(updateSession).toHaveBeenCalledTimes(3)
    for (const call of updateSession.mock.calls) {
      expect("folderId" in (call[1] as Record<string, unknown>)).toBe(false)
    }
  })

  it("refuses an archived conversation and writes nothing", async () => {
    seed()
    const { result } = renderHook(() => useMoveSessionWorkspace())

    let moved = true
    await act(async () => {
      moved = await result.current.move({ ...session, archivedAt: 123 }, "project-b")
    })

    expect(moved).toBe(false)
    expect(updateSession).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
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

  it("cannot move an archived conversation, which stays frozen in place", () => {
    seed()
    const { result } = renderHook(() => useSessionWorkspaceMoveMenu({ ...session, archivedAt: 1 }))
    expect(result.current.workspaceTargets).toHaveLength(2)
    expect(result.current.canMoveWorkspace).toBe(false)
  })
})
