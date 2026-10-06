/**
 * @jest-environment jsdom
 */
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  handleTeamTaskComment,
  handleTeamTaskCreate,
  handleTeamTaskMove,
  handleTeamRunStart,
} from "./agent-team-write-handlers"
import { startSquadRun } from "@/lib/ai/agent/team/squad/start-squad-run"
import { resolveGatePolicy } from "@/lib/ai/agent/team/gates/gate-policy"

jest.mock("@/lib/ai/agent/team/squad/start-squad-run", () => ({
  startSquadRun: jest.fn(),
}))

jest.mock("@/lib/share/hash", () => ({
  sha256Hex: async (value: string) =>
    jest
      .requireActual<typeof import("node:crypto")>("node:crypto")
      .createHash("sha256")
      .update(value)
      .digest("hex"),
}))

jest.mock("@/lib/ai/agent/team/agent-team", () => ({
  agentTeamManager: {
    pause: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
  },
}))

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    createLogger: () => ({ ...child, child: () => child }),
    logger: { ...child, child: () => child },
    loggers: {
      agent: { ...child, child: () => child },
      plugin: { ...child, child: () => child },
    },
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

const seed = () => {
  const state = useAgentTeamStore.getState()
  const team = state.createTeam({ name: "T", task: "t" })
  const mate = state.addTeammate({
    teamId: team.id,
    name: "Worker",
    description: "",
    role: "teammate",
  })
  const failed = state.createTask({ teamId: team.id, title: "F", description: "" })
  state.updateTask(failed.id, { status: "failed", error: "boom" })
  return { team, mate, failed }
}

beforeEach(() => {
  localStorage.clear()
  useAgentTeamStore.getState().reset()
  jest.clearAllMocks()
})

describe("handleTeamTaskMove", () => {
  it("rejects malformed payloads and unknown statuses/tasks", async () => {
    const { team } = seed()
    expect(await handleTeamTaskMove({})).toEqual({ ok: false, reason: "invalid-payload" })
    expect(await handleTeamTaskMove({ teamId: team.id, taskId: "t", to: "warp" })).toEqual({
      ok: false,
      reason: "invalid-status",
    })
    expect(await handleTeamTaskMove({ teamId: team.id, taskId: "nope", to: "pending" })).toEqual({
      ok: false,
      reason: "task-not-found",
    })
    // A task from another team is invisible through this team's id.
    const other = useAgentTeamStore.getState().createTeam({ name: "O", task: "" })
    const foreign = useAgentTeamStore
      .getState()
      .createTask({ teamId: other.id, title: "x", description: "" })
    expect(
      await handleTeamTaskMove({ teamId: team.id, taskId: foreign.id, to: "cancelled" })
    ).toEqual({ ok: false, reason: "task-not-found" })
  })

  it("applies guarded moves and surfaces guard denials", async () => {
    const { team, failed } = seed()
    expect(await handleTeamTaskMove({ teamId: team.id, taskId: failed.id, to: "pending" })).toEqual(
      { ok: true }
    )
    expect(useAgentTeamStore.getState().tasks[failed.id].status).toBe("pending")
    expect(
      await handleTeamTaskMove({ teamId: team.id, taskId: failed.id, to: "completed" })
    ).toEqual({ ok: false, reason: "illegal-transition" })
  })
})

describe("handleTeamTaskCreate", () => {
  it("creates a task with validated priority/assignee/tags", async () => {
    const { team, mate } = seed()
    const result = await handleTeamTaskCreate({
      teamId: team.id,
      title: "From phone",
      priority: "high",
      assignedTo: mate.id,
      tags: ["mobile", 42],
    })
    expect(result.ok).toBe(true)
    const task = useAgentTeamStore.getState().tasks[result.taskId!]
    expect(task).toMatchObject({
      title: "From phone",
      priority: "high",
      assignedTo: mate.id,
      tags: ["mobile"],
    })
  })

  it("defaults tags to [] when the payload omits or malforms them", async () => {
    const { team } = seed()
    const result = await handleTeamTaskCreate({ teamId: team.id, title: "no tags" })
    expect(useAgentTeamStore.getState().tasks[result.taskId!].tags).toEqual([])
    const result2 = await handleTeamTaskCreate({ teamId: team.id, title: "bad tags", tags: "x" })
    expect(useAgentTeamStore.getState().tasks[result2.taskId!].tags).toEqual([])
  })

  it("rejects unknown teams, bad priorities, and off-team assignees", async () => {
    const { team } = seed()
    expect(await handleTeamTaskCreate({ teamId: "ghost", title: "x" })).toEqual({
      ok: false,
      reason: "team-not-found",
    })
    expect(await handleTeamTaskCreate({ teamId: team.id, title: "x", priority: "asap" })).toEqual({
      ok: false,
      reason: "invalid-priority",
    })
    expect(
      await handleTeamTaskCreate({ teamId: team.id, title: "x", assignedTo: "stranger" })
    ).toEqual({ ok: false, reason: "assignee-not-on-team" })
  })
})

describe("handleTeamTaskComment", () => {
  it("appends an operator comment and returns its id", async () => {
    const { team, failed } = seed()
    const result = await handleTeamTaskComment({
      teamId: team.id,
      taskId: failed.id,
      text: "Look at this",
    })
    expect(result.ok).toBe(true)
    const comments = useAgentTeamStore.getState().tasks[failed.id].comments ?? []
    expect(comments.map((c) => c.id)).toContain(result.commentId)
    expect(comments[0]).toMatchObject({ authorId: "user", text: "Look at this" })
  })

  it("rejects unknown tasks", async () => {
    const { team } = seed()
    expect(await handleTeamTaskComment({ teamId: team.id, taskId: "zz", text: "x" })).toEqual({
      ok: false,
      reason: "task-not-found",
    })
  })
})

describe("handleTeamRunStart", () => {
  const launchId = "e04469bc-e100-43f8-9e15-a96c0d7f1847"
  const request = { teamId: "squad-1", launchId, callerDeviceId: "phone-1" }
  const start = jest.mocked(startSquadRun)

  it.each([
    {},
    { ...request, teamId: " " },
    { ...request, launchId: "invalid" },
    { ...request, goal: 1 },
    { ...request, ultracode: "yes" },
  ])("refuses invalid input without dispatch: %j", async (payload) => {
    expect(await handleTeamRunStart(payload)).toEqual({ started: false, reason: "invalid_payload" })
    expect(start).not.toHaveBeenCalled()
  })

  it.each([undefined, "", " "])(
    "requires authenticated device provenance: %j",
    async (callerDeviceId) => {
      expect(await handleTeamRunStart({ ...request, callerDeviceId })).toEqual({
        started: false,
        reason: "caller_device_required",
      })
      expect(start).not.toHaveBeenCalled()
    }
  )

  it("hands manual intent to the only launch seam without accepting caller authority", async () => {
    const accepted = {
      started: true,
      runId: "r1",
      executionRunId: "execution:team:r1",
      squadName: "S",
    }
    start.mockResolvedValueOnce(accepted)
    expect(
      await handleTeamRunStart({
        ...request,
        goal: "Review release",
        ultracode: true,
        origin: "scheduler",
        permissionCeiling: { permissionMode: "bypassPermissions" },
        parentRunId: "victim",
        executionConstraints: {},
        runId: "borrowed",
      })
    ).toBe(accepted)
    const input = start.mock.calls[0][0]
    expect(input).toEqual({
      squadId: "squad-1",
      goal: "Review release",
      ultracode: true,
      runId: expect.stringMatching(/^squad-companion:[a-f0-9]{64}$/),
      origin: "interactive",
      triggeredFrom: { source: "api", deviceId: "phone-1" },
    })
    expect(resolveGatePolicy(input.origin as "interactive").planApproval).toBe("block")
  })

  it("keeps logical run identity across lease retries and UUID casing, but isolates devices", async () => {
    start.mockResolvedValue({ started: true, duplicate: true })
    await handleTeamRunStart(request)
    await handleTeamRunStart({
      ...request,
      launchId: launchId.toUpperCase(),
      adminLease: "new-lease",
    })
    await handleTeamRunStart({ ...request, callerDeviceId: "phone-2" })
    await handleTeamRunStart({ ...request, launchId: "090283fb-a337-4f1b-8c11-2a29c33f0b7d" })
    const ids = start.mock.calls.map(([input]) => input.runId)
    expect(ids[0]).toBe(ids[1])
    expect(new Set(ids)).toHaveProperty("size", 3)
    expect(start.mock.calls[0][0]).toMatchObject({ goal: "" })
  })

  it.each([
    { started: false, reason: "squad_not_found" },
    { started: false, reason: "runtime_not_ready" },
    { started: false, reason: "journal_failed" },
    {
      started: false,
      reason: "already_running",
      runId: "busy",
      executionRunId: "execution:team:busy",
    },
    {
      started: false,
      reason: "not_ready",
      blockers: [{ code: "missing_primary_repository", action: "configure_repository" }],
    },
    {
      started: true,
      runId: "existing",
      executionRunId: "execution:team:existing",
      duplicate: true,
    },
  ] as const)("preserves the canonical admission result: %j", async (outcome) => {
    start.mockResolvedValueOnce(outcome as Awaited<ReturnType<typeof startSquadRun>>)
    expect(await handleTeamRunStart(request)).toBe(outcome)
  })

  it("returns a structured dispatch refusal if the launch boundary throws", async () => {
    start.mockRejectedValueOnce(new Error("storage failed"))
    expect(await handleTeamRunStart(request)).toEqual({ started: false, reason: "dispatch_error" })
  })
})
