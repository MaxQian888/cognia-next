/**
 * Coverage for the CLI-bridge agent-team renderer handlers: store-backed
 * list projection (redacted), fire-and-forget run dispatch with the remote
 * origin, and the run-status projection (synthesized-run filter reuse +
 * PII-gated run_log messages, never step payloads).
 */

const storeState: { teams: Record<string, unknown> } = { teams: {} }
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => storeState },
}))

const redactTextMock = jest.fn((text: string) => ({ redacted: text, map: {} }))
const hasNoLeakingPiiMock = jest.fn<boolean, [string]>(() => true)
jest.mock("@cognia/redact", () => ({
  redactText: (text: string) => redactTextMock(text),
  hasNoLeakingPii: (text: string) => hasNoLeakingPiiMock(text),
}))

const managerGetMock = jest.fn()
const managerStartMock = jest.fn()
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    get: (...args: unknown[]) => managerGetMock(...args),
    start: (...args: unknown[]) => managerStartMock(...args),
  },
}))

const runsRows: Array<Record<string, unknown>> = []
const eventRows: Array<Record<string, unknown>> = []
const durableRuns: Array<Record<string, unknown>> = []
const executionRuns: Record<string, Record<string, unknown>> = {}
const executionEvents: Array<Record<string, unknown>> = []
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    agentTeamRuns: {
      where: () => ({ equals: () => ({ toArray: async () => durableRuns }) }),
    },
    executionRuns: { get: async (id: string) => executionRuns[id] },
    executionRunEvents: {
      where: () => ({ equals: () => ({ sortBy: async () => executionEvents }) }),
    },
    workflowRuns: {
      where: () => ({
        equals: () => ({
          reverse: () => ({ sortBy: async () => runsRows }),
        }),
      }),
    },
    workflowRunEvents: {
      where: () => ({
        equals: () => ({ sortBy: async () => eventRows }),
      }),
    },
  }),
}))

jest.mock("@/lib/ai/agent/team/team-workflow-id", () => ({
  isSynthesizedTeamRunPayload: (payload: unknown, teamId: string) => {
    const p = payload as { teamId?: string; event?: string } | undefined
    return p?.teamId === teamId && p?.event === undefined
  },
}))

import { agentTeamList, agentTeamRun, agentTeamRunStatus } from "./agent-team"

beforeEach(() => {
  storeState.teams = {}
  runsRows.length = 0
  eventRows.length = 0
  durableRuns.length = 0
  executionEvents.length = 0
  for (const key of Object.keys(executionRuns)) delete executionRuns[key]
  redactTextMock.mockClear().mockImplementation((text: string) => ({ redacted: text, map: {} }))
  hasNoLeakingPiiMock.mockClear().mockReturnValue(true)
  managerGetMock.mockReset()
  managerStartMock.mockReset().mockResolvedValue(undefined)
})

describe("agentTeamList", () => {
  it("projects store teams with redacted name/objective", async () => {
    redactTextMock.mockImplementation((text: string) => ({
      redacted: text.replace("Bob", "<NAME_001>"),
      map: {},
    }))
    storeState.teams = {
      t1: { id: "t1", name: "Bob's team", status: "idle", task: "help Bob", teammateIds: ["a"] },
    }
    const out = await agentTeamList()
    expect(out.ok).toBe(true)
    expect(out.teams).toEqual([
      {
        id: "t1",
        name: "<NAME_001>'s team",
        status: "idle",
        objective: "help <NAME_001>",
        teammateCount: 1,
      },
    ])
  })
})

describe("agentTeamRun", () => {
  it("requires a teamId and an existing team", async () => {
    expect((await agentTeamRun({})).ok).toBe(false)
    managerGetMock.mockReturnValue(undefined)
    const out = await agentTeamRun({ teamId: "missing" })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/not found/)
  })

  it("dispatches fire-and-forget with the remote origin", async () => {
    managerGetMock.mockReturnValue({ id: "t1" })
    const out = await agentTeamRun({ teamId: "t1", ultracode: true })
    expect(out).toEqual({ ok: true, teamId: "t1", started: true })
    expect(managerStartMock).toHaveBeenCalledWith("t1", { origin: "remote", ultracode: true })
  })
})

describe("agentTeamRunStatus", () => {
  /**
   * ADR-0169: the durable run is the record. The CLI reads the same execution
   * journal the cockpit projects, gated the same way, and never the legacy
   * workflow row when a durable one exists.
   */
  it("projects the durable run and its journal before any legacy row", async () => {
    durableRuns.push({
      id: "run_team_1",
      teamId: "t1",
      status: "needs_input",
      recoveryReason: "evidence_incomplete",
      createdAt: 5,
      startedAt: 10,
      updatedAt: 50,
    })
    executionRuns["execution:team:run_team_1"] = {
      id: "execution:team:run_team_1",
      status: "waiting",
    }
    executionEvents.push(
      { ts: 5, type: "run.started", visibility: "summary", payload: { teamId: "t1" } },
      { ts: 20, type: "step.started", visibility: "summary", payload: { stepId: "task-1" } },
      {
        ts: 25,
        type: "tool.started",
        visibility: "private",
        payload: { summary: "NEVER FORWARDED" },
      },
      { ts: 30, type: "run.waiting", visibility: "summary", payload: { summary: "leaky secret" } }
    )
    runsRows.push({
      id: "r-legacy",
      status: "running",
      triggerPayload: { teamId: "t1" },
      startedAt: 1,
    })
    hasNoLeakingPiiMock.mockImplementation((text) => text !== "leaky secret")

    const out = await agentTeamRunStatus({ teamId: "t1", sinceTs: 10 })
    expect(out.run).toEqual({
      runId: "run_team_1",
      status: "waiting",
      startedAt: 10,
      error: "evidence_incomplete",
    })
    expect(out.events).toEqual([
      { ts: 20, type: "step.started", stepId: "task-1" },
      { ts: 30, type: "run.waiting" },
    ])
    expect(JSON.stringify(out)).not.toContain("NEVER FORWARDED")
    expect(JSON.stringify(out)).not.toContain("leaky secret")
    expect(JSON.stringify(out)).not.toContain("r-legacy")
  })

  it("returns ok without a run when the team has no synthesized run", async () => {
    runsRows.push({
      id: "r-fanout",
      status: "running",
      triggerPayload: { teamId: "t1", event: "team.completed" },
      startedAt: 10,
    })
    const out = await agentTeamRunStatus({ teamId: "t1" })
    expect(out).toEqual({ ok: true })
  })

  it("projects the newest run + events since the cursor, PII-gating run_log", async () => {
    runsRows.push({
      id: "r-1",
      status: "running",
      triggerPayload: { teamId: "t1" },
      startedAt: 10,
      error: { message: "leaky secret" },
    })
    eventRows.push(
      { id: "e0", runId: "r-1", ts: 5, type: "run_started" },
      {
        id: "e1",
        runId: "r-1",
        ts: 20,
        type: "run_log",
        stepId: "s1",
        payload: { message: "safe log line" },
      },
      {
        id: "e2",
        runId: "r-1",
        ts: 30,
        type: "step_completed",
        stepId: "s1",
        payload: { output: "NEVER FORWARDED" },
      }
    )
    hasNoLeakingPiiMock.mockImplementation((text) => text !== "leaky secret")

    const out = await agentTeamRunStatus({ teamId: "t1", sinceTs: 10 })
    expect(out.run).toEqual({ runId: "r-1", status: "running", startedAt: 10 })
    expect(out.events).toEqual([
      { ts: 20, type: "run_log", stepId: "s1", message: "safe log line" },
      { ts: 30, type: "step_completed", stepId: "s1" },
    ])
    // Step payloads never cross the bridge.
    expect(JSON.stringify(out)).not.toContain("NEVER FORWARDED")
    expect(JSON.stringify(out)).not.toContain("leaky secret")
  })
})
