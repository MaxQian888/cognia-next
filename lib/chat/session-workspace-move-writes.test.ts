/**
 * @jest-environment jsdom
 */
import type { Project } from "@/types"

const updateSession = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/sessions", () => ({ updateSession: (...a: unknown[]) => updateSession(...a) }))

// null = no Host takes the session (unpaired, or the Host has no snapshot yet).
const enqueue = jest.fn(async (..._a: unknown[]): Promise<unknown> => null)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (...a: unknown[]) => enqueue(...a),
}))

const sessionRows = new Map<string, Record<string, unknown>>()
const folderRows = new Map<string, { id: string; projectId?: string }>()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions: { get: async (id: string) => sessionRows.get(id) },
    sessionFolders: { get: async (id: string) => folderRows.get(id) },
  }),
}))

import { getExecutionBroker } from "@/lib/execution/broker"
import { useProjectStore } from "@/stores/project/project-store"
import {
  moveSessionWorkspaceLocally,
  moveSessionWorkspaceRouted,
  type MovableSession,
} from "./session-workspace-move-writes"

const session: MovableSession = { id: "s1", projectId: "project-a" }

function seed(running = false) {
  jest.spyOn(getExecutionBroker(), "hasActiveSession").mockReturnValue(running)
  useProjectStore.setState({
    loaded: true,
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

function rosters(): Record<string, string[]> {
  return Object.fromEntries(
    useProjectStore.getState().projects.map((project) => [project.id, project.sessionIds])
  )
}

beforeEach(() => {
  sessionRows.clear()
  folderRows.clear()
  updateSession.mockReset().mockResolvedValue(undefined)
  enqueue.mockReset().mockResolvedValue(null)
})

afterEach(() => jest.restoreAllMocks())

describe("moveSessionWorkspaceRouted", () => {
  it("writes the move here when no Host takes the session", async () => {
    seed()
    folderRows.set("f-a", { id: "f-a", projectId: "project-a" })

    const result = await moveSessionWorkspaceRouted({ ...session, folderId: "f-a" }, "project-b")

    expect(result).toEqual({ status: "moved" })
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [id, patch] = updateSession.mock.calls[0] as [
      string,
      { projectId: string; executionContext?: { projectRoot?: string }; folderId?: string },
    ]
    expect(id).toBe("s1")
    expect(patch.projectId).toBe("project-b")
    expect(patch.executionContext?.projectRoot).toBe("/repos/b")
    // A folder of the old workspace cannot hold it in the new one.
    expect("folderId" in patch).toBe(true)
    expect(patch.folderId).toBeUndefined()
    expect(rosters()).toEqual({ "project-a": [], "project-b": ["s1"] })
  })

  it("hands the move to the Host and writes nothing on a paired client", async () => {
    seed()
    enqueue.mockResolvedValueOnce({ id: "job-1" })

    const result = await moveSessionWorkspaceRouted(session, "project-b")

    expect(result).toEqual({ status: "sent-to-host" })
    // The client's plan is never sent: only the destination travels.
    expect(enqueue).toHaveBeenCalledWith({
      sessionId: "s1",
      action: { kind: "session.workspace", projectId: "project-b" },
    })
    expect(updateSession).not.toHaveBeenCalled()
    expect(rosters()).toEqual({ "project-a": ["s1"], "project-b": [] })
  })

  it.each([
    ["same-workspace", session, "project-a", false],
    ["unknown-workspace", session, "project-missing", false],
    ["session-archived", { ...session, archivedAt: 5 }, "project-b", false],
    [
      "session-locked",
      { ...session, handoffLock: { ticketId: "t", state: "frozen", at: 1 } },
      "project-b",
      false,
    ],
    ["session-running", session, "project-b", true],
  ] as const)(
    "refuses %s before anything is written or sent",
    async (reason, input, target, running) => {
      seed(running)
      const result = await moveSessionWorkspaceRouted(input as MovableSession, target)
      expect(result).toEqual({ status: "refused", reason })
      expect(enqueue).not.toHaveBeenCalled()
      expect(updateSession).not.toHaveBeenCalled()
    }
  )

  it("hydrates the workspace store before it plans", async () => {
    seed()
    const hydrated = useProjectStore.getState()
    const load = jest.fn(async () => {
      useProjectStore.setState({ loaded: true, load: hydrated.load })
    })
    useProjectStore.setState({ loaded: false, load })

    await moveSessionWorkspaceRouted(session, "project-b")

    expect(load).toHaveBeenCalledTimes(1)
    expect(rosters()["project-b"]).toEqual(["s1"])
  })

  it("throws a failed local write and leaves the rosters alone", async () => {
    seed()
    updateSession.mockRejectedValueOnce(new Error("db closed"))
    await expect(moveSessionWorkspaceRouted(session, "project-b")).rejects.toThrow("db closed")
    expect(rosters()).toEqual({ "project-a": ["s1"], "project-b": [] })
  })

  it("propagates a full outbox rather than silently writing locally", async () => {
    seed()
    enqueue.mockRejectedValueOnce(new Error("mobile_outbound_queue_full"))
    await expect(moveSessionWorkspaceRouted(session, "project-b")).rejects.toThrow(
      "mobile_outbound_queue_full"
    )
    expect(updateSession).not.toHaveBeenCalled()
  })
})

describe("moveSessionWorkspaceLocally", () => {
  it("reads the row from Dexie and moves it here without routing", async () => {
    seed()
    sessionRows.set("s1", { id: "s1", projectId: "project-a" })

    await expect(moveSessionWorkspaceLocally("s1", "project-b")).resolves.toEqual({
      status: "moved",
    })

    expect(enqueue).not.toHaveBeenCalled()
    expect(updateSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ projectId: "project-b" })
    )
    expect(rosters()).toEqual({ "project-a": [], "project-b": ["s1"] })
  })

  it("re-plans against the current row and drops a move that is no longer valid", async () => {
    seed(true)
    sessionRows.set("s1", { id: "s1", projectId: "project-a" })

    await expect(moveSessionWorkspaceLocally("s1", "project-b")).resolves.toEqual({
      status: "refused",
      reason: "session-running",
    })
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("throws when the row is gone", async () => {
    seed()
    await expect(moveSessionWorkspaceLocally("s-missing", "project-b")).rejects.toThrow(
      "session s-missing not found"
    )
    expect(updateSession).not.toHaveBeenCalled()
  })
})
