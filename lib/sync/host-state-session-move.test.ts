/**
 * @jest-environment jsdom
 */
import type { Project } from "@/types"
import type { HostStateTurnStatus } from "@cognia/agent-config-types/host-state"
import type { MoveSessionRefusal } from "@/lib/chat/move-session-workspace"
import { getExecutionBroker } from "@/lib/execution/broker"
import { useProjectStore } from "@/stores/project/project-store"
import {
  hostSessionMoveRejection,
  planHostSessionMove,
  relinkMovedSessionRoster,
  type PlanHostSessionMoveInput,
} from "./host-state-session-move"

type Db = Parameters<typeof planHostSessionMove>[0]

const projects: Record<string, unknown> = {
  "p-a": { id: "p-a", name: "A", roots: [{ id: "ra", path: "/host/a", isPrimary: true }] },
  "p-b": { id: "p-b", name: "B", roots: [{ id: "rb", path: "/host/b", isPrimary: true }] },
  "p-gone": { id: "p-gone", name: "Gone", roots: [], isArchived: true },
}
const folders: Record<string, unknown> = {
  "f-a": { id: "f-a", projectId: "p-a" },
  "f-any": { id: "f-any" },
}

const db = {
  projects: { get: async (id: string) => projects[id] },
  sessionFolders: { get: jest.fn(async (id: string) => folders[id]) },
} as unknown as Db

function input(overrides: Partial<PlanHostSessionMoveInput> = {}): PlanHostSessionMoveInput {
  return {
    session: { id: "s1", projectId: "p-a" },
    projectId: "p-b",
    now: 10,
    ...overrides,
  }
}

let hasActiveSession: jest.SpyInstance
beforeEach(() => {
  hasActiveSession = jest.spyOn(getExecutionBroker(), "hasActiveSession").mockReturnValue(false)
})
afterEach(() => jest.restoreAllMocks())

describe("planHostSessionMove", () => {
  it("rebuilds the context against the Host's own destination row", async () => {
    const plan = await planHostSessionMove(db, input())
    expect(plan).toMatchObject({
      ok: true,
      projectId: "p-b",
      previousProjectId: "p-a",
      clearFolder: false,
      executionContext: { projectRoot: "/host/b" },
    })
  })

  it("unfiles from a folder of the old workspace, keeps an unscoped one", async () => {
    await expect(
      planHostSessionMove(db, input({ session: { id: "s1", projectId: "p-a", folderId: "f-a" } }))
    ).resolves.toMatchObject({ ok: true, clearFolder: true })
    await expect(
      planHostSessionMove(db, input({ session: { id: "s1", projectId: "p-a", folderId: "f-any" } }))
    ).resolves.toMatchObject({ ok: true, clearFolder: false })
    // A folder that is gone holds nothing to clear.
    await expect(
      planHostSessionMove(db, input({ session: { id: "s1", projectId: "p-a", folderId: "f-x" } }))
    ).resolves.toMatchObject({ ok: true, clearFolder: false })
  })

  it("does not read a folder for an unfiled session", async () => {
    ;(db.sessionFolders.get as unknown as jest.Mock).mockClear()
    await planHostSessionMove(db, input())
    expect(db.sessionFolders.get).not.toHaveBeenCalled()
  })

  it("treats an archived or missing destination as unknown", async () => {
    await expect(planHostSessionMove(db, input({ projectId: "p-gone" }))).resolves.toEqual({
      ok: false,
      reason: "unknown-workspace",
    })
    await expect(planHostSessionMove(db, input({ projectId: "p-none" }))).resolves.toEqual({
      ok: false,
      reason: "unknown-workspace",
    })
  })

  it("refuses what the shared planner refuses", async () => {
    await expect(planHostSessionMove(db, input({ projectId: "p-a" }))).resolves.toEqual({
      ok: false,
      reason: "same-workspace",
    })
    await expect(
      planHostSessionMove(db, input({ session: { id: "s1", projectId: "p-a", archivedAt: 1 } }))
    ).resolves.toEqual({ ok: false, reason: "session-archived" })
    await expect(
      planHostSessionMove(
        db,
        input({
          session: {
            id: "s1",
            projectId: "p-a",
            handoffLock: { ticketId: "t", state: "frozen", at: 1 },
          },
        })
      )
    ).resolves.toEqual({ ok: false, reason: "session-locked" })
  })

  it("is running when the broker holds a leg, whatever the channel says", async () => {
    hasActiveSession.mockReturnValue(true)
    await expect(planHostSessionMove(db, input({ turn: "idle" }))).resolves.toEqual({
      ok: false,
      reason: "session-running",
    })
    expect(hasActiveSession).toHaveBeenCalledWith("s1")
  })

  it.each<[HostStateTurnStatus, boolean]>([
    ["queued", true],
    ["running", true],
    ["awaiting-decision", true],
    ["stopping", true],
    ["idle", false],
    ["completed", false],
    ["aborted", false],
    ["retryable-error", false],
    ["fatal-error", false],
  ])("a channel turn %s counts as running: %s", async (turn, running) => {
    const plan = await planHostSessionMove(db, input({ turn }))
    expect(plan.ok).toBe(!running)
  })
})

describe("hostSessionMoveRejection", () => {
  it("gives every refusal its own code and a message", () => {
    const reasons: MoveSessionRefusal[] = [
      "same-workspace",
      "unknown-workspace",
      "session-running",
      "session-locked",
      "session-archived",
    ]
    const codes = reasons.map((reason) => hostSessionMoveRejection(reason))
    expect(codes.map((rejection) => rejection.code)).toEqual([
      "host_state_move_same_workspace",
      "host_state_move_unknown_workspace",
      "host_state_move_session_running",
      "host_state_move_session_locked",
      "host_state_move_session_archived",
    ])
    for (const rejection of codes) expect(rejection.message.length).toBeGreaterThan(0)
  })
})

describe("relinkMovedSessionRoster", () => {
  function seedStore(loaded: boolean) {
    useProjectStore.setState({
      loaded,
      projects: [
        { id: "p-a", name: "A", roots: [], sessionIds: ["s1", "s2"] },
        { id: "p-b", name: "B", roots: [], sessionIds: [] },
      ] as unknown as Project[],
    })
  }
  const rosters = () =>
    Object.fromEntries(useProjectStore.getState().projects.map((p) => [p.id, p.sessionIds]))

  it("unlinks from the old workspace and links into the new one", async () => {
    seedStore(true)
    await relinkMovedSessionRoster("s1", "p-a", "p-b")
    expect(rosters()).toEqual({ "p-a": ["s2"], "p-b": ["s1"] })
  })

  it("only links when the session had no workspace", async () => {
    seedStore(true)
    await relinkMovedSessionRoster("s3", undefined, "p-b")
    expect(rosters()).toEqual({ "p-a": ["s1", "s2"], "p-b": ["s3"] })
  })

  it("hydrates the store first, so a headless Host's roster write persists", async () => {
    seedStore(false)
    const hydrated = useProjectStore.getState()
    const order: string[] = []
    useProjectStore.setState({
      load: jest.fn(async () => {
        order.push("load")
        useProjectStore.setState({ loaded: true, load: hydrated.load })
      }),
    })
    const original = hydrated.addSessionToProject
    useProjectStore.setState({
      addSessionToProject: (projectId: string, sessionId: string) => {
        order.push("link")
        original(projectId, sessionId)
      },
    })
    try {
      await relinkMovedSessionRoster("s1", "p-a", "p-b")
    } finally {
      useProjectStore.setState({ addSessionToProject: original })
    }
    expect(order).toEqual(["load", "link"])
    expect(rosters()).toEqual({ "p-a": ["s2"], "p-b": ["s1"] })
  })
})
