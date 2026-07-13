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
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
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

jest.mock("@/components/agent/team/runs-list", () => ({
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
