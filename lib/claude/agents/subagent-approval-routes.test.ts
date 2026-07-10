import {
  registerSubagentApprovalRoute,
  getSubagentApprovalRoute,
  clearSubagentApprovalRoute,
  __clearAllSubagentApprovalRoutesForTesting,
} from "./subagent-approval-routes"

const route = {
  parentSessionId: "chat-1",
  runId: "run-1",
  subagentId: "explore",
  backgrounded: false,
}

beforeEach(() => __clearAllSubagentApprovalRoutesForTesting())

describe("subagent approval routes", () => {
  it("registers, resolves, and clears a route by ephemeral session id", () => {
    registerSubagentApprovalRoute("eph-1", route)
    expect(getSubagentApprovalRoute("eph-1")).toEqual(route)

    clearSubagentApprovalRoute("eph-1")
    expect(getSubagentApprovalRoute("eph-1")).toBeUndefined()
  })

  it("returns undefined for unknown sessions", () => {
    expect(getSubagentApprovalRoute("ghost")).toBeUndefined()
  })

  it("last registration wins for the same session id", () => {
    registerSubagentApprovalRoute("eph-1", route)
    registerSubagentApprovalRoute("eph-1", { ...route, runId: "run-2" })
    expect(getSubagentApprovalRoute("eph-1")?.runId).toBe("run-2")
  })
})
