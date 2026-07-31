import { renderHook } from "@testing-library/react"
import {
  deriveTeamStatus,
  workflowRunStatusToTeamStatus,
  pickNewestRunStatus,
  useTeamLiveStatus,
} from "./use-team-live-status"
import type { AgentTeam, TeamStatus } from "@/types/agent/agent-team"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"

// useTeamLiveStatus calls useLiveQuery once (the newest team run row's status).
let liveRunStatus: RunStatus | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveRunStatus,
}))
// The Dexie querier closure never runs under the mock; stub the import.
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))

const teamWith = (status: TeamStatus): AgentTeam => ({ id: "team-1", status }) as AgentTeam

describe("workflowRunStatusToTeamStatus", () => {
  const cases: Array<[RunStatus, string]> = [
    ["pending", "executing"],
    ["running", "executing"],
    ["waiting", "executing"],
    ["paused", "paused"],
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ]
  it.each(cases)("maps run status %s to team status %s", (run, team) => {
    expect(workflowRunStatusToTeamStatus(run)).toBe(team)
  })
})

describe("deriveTeamStatus", () => {
  it("prefers a live (non-terminal) store status so an in-flight run shows immediately", () => {
    // run row still says succeeded from a prior run, but store is executing now
    expect(deriveTeamStatus("executing", "succeeded")).toBe("executing")
    expect(deriveTeamStatus("planning", undefined)).toBe("planning")
    expect(deriveTeamStatus("paused", "running")).toBe("paused")
  })

  it("derives from the newest durable run row when the store is terminal/idle", () => {
    expect(deriveTeamStatus("idle", "running")).toBe("executing")
    expect(deriveTeamStatus("completed", "failed")).toBe("failed")
    expect(deriveTeamStatus("idle", "succeeded")).toBe("completed")
  })

  it("falls back to the store status when there is no run row yet", () => {
    expect(deriveTeamStatus("idle", undefined)).toBe("idle")
    expect(deriveTeamStatus("completed", undefined)).toBe("completed")
  })
})

describe("pickNewestRunStatus", () => {
  const row = (id: string, startedAt: number, status: RunStatus): WorkflowRunRow =>
    ({ id, workflowId: "__team__:t:1", startedAt, status }) as WorkflowRunRow

  it("returns undefined for an empty list", () => {
    expect(pickNewestRunStatus([])).toBeUndefined()
  })

  it("returns the status of the most-recently-started row", () => {
    const rows = [row("a", 100, "succeeded"), row("b", 300, "running"), row("c", 200, "failed")]
    expect(pickNewestRunStatus(rows)).toBe("running")
  })
})

describe("useTeamLiveStatus", () => {
  it("derives from the newest run row when the store is terminal", () => {
    liveRunStatus = "running"
    const { result } = renderHook(() => useTeamLiveStatus(teamWith("completed")))
    expect(result.current).toBe("executing")
  })

  it("keeps the live store status while a run is in flight", () => {
    liveRunStatus = "succeeded"
    const { result } = renderHook(() => useTeamLiveStatus(teamWith("executing")))
    expect(result.current).toBe("executing")
  })

  it("falls back to the store status when no run row exists", () => {
    liveRunStatus = undefined
    const { result } = renderHook(() => useTeamLiveStatus(teamWith("idle")))
    expect(result.current).toBe("idle")
  })
})
