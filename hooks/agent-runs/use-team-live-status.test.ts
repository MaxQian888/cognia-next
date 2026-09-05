import { renderHook } from "@testing-library/react"
import {
  deriveTeamStatus,
  pickNewestRunStatus,
  runRecordStatusToTeamStatus,
  useTeamLiveStatus,
} from "./use-team-live-status"
import type { AgentTeam, TeamStatus } from "@/types/agent/agent-team"
import type { AgentTeamRunRecord, AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"

// useTeamLiveStatus calls useLiveQuery once (the newest run record's status).
let liveRunStatus: AgentTeamRunStatus | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveRunStatus,
}))
// The Dexie querier closure never runs under the mock. Stub the import.
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))

const teamWith = (status: TeamStatus): AgentTeam => ({ id: "team-1", status }) as AgentTeam

describe("runRecordStatusToTeamStatus", () => {
  const cases: Array<[AgentTeamRunStatus, TeamStatus]> = [
    ["queued", "executing"],
    ["running", "executing"],
    ["recovering", "executing"],
    ["pausing", "paused"],
    ["paused", "paused"],
    ["sleeping", "paused"],
    ["needs_input", "paused"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["terminated", "cancelled"],
  ]
  it.each(cases)("maps run status %s to team status %s", (run, team) => {
    expect(runRecordStatusToTeamStatus(run)).toBe(team)
  })
})

describe("deriveTeamStatus", () => {
  it("prefers a live (non-terminal) store status so an in-flight run shows immediately", () => {
    expect(deriveTeamStatus("executing", "completed")).toBe("executing")
    expect(deriveTeamStatus("planning", undefined)).toBe("planning")
    expect(deriveTeamStatus("paused", "running")).toBe("paused")
  })

  it("falls through to the newest durable run when the store is terminal or idle", () => {
    expect(deriveTeamStatus("idle", "running")).toBe("executing")
    expect(deriveTeamStatus("completed", "failed")).toBe("failed")
    expect(deriveTeamStatus("idle", "needs_input")).toBe("paused")
  })

  it("keeps the store status when no run record exists yet", () => {
    expect(deriveTeamStatus("idle", undefined)).toBe("idle")
    expect(deriveTeamStatus("completed", undefined)).toBe("completed")
  })
})

describe("pickNewestRunStatus", () => {
  const row = (id: string, status: AgentTeamRunStatus, updatedAt: number): AgentTeamRunRecord =>
    ({ id, teamId: "team-1", status, updatedAt }) as AgentTeamRunRecord

  it("returns undefined for no rows", () => {
    expect(pickNewestRunStatus([])).toBeUndefined()
  })

  it("returns the status of the most recently updated row regardless of order", () => {
    expect(
      pickNewestRunStatus([
        row("a", "completed", 100),
        row("b", "running", 300),
        row("c", "failed", 200),
      ])
    ).toBe("running")
  })
})

describe("useTeamLiveStatus", () => {
  beforeEach(() => {
    liveRunStatus = undefined
  })

  it("returns the store status when there is no durable run", () => {
    const { result } = renderHook(() => useTeamLiveStatus(teamWith("idle")))
    expect(result.current).toBe("idle")
  })

  it("returns the durable run status when the store is idle", () => {
    liveRunStatus = "running"
    const { result } = renderHook(() => useTeamLiveStatus(teamWith("idle")))
    expect(result.current).toBe("executing")
  })

  it("keeps a live store status over a stale durable status", () => {
    liveRunStatus = "completed"
    const { result } = renderHook(() => useTeamLiveStatus(teamWith("executing")))
    expect(result.current).toBe("executing")
  })
})
