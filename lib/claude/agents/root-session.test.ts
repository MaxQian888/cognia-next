import { resolveRootSessionId } from "./root-session"
import {
  __clearAllSubagentApprovalRoutesForTesting,
  clearSubagentApprovalRoute,
  registerSubagentApprovalRoute,
} from "./subagent-approval-routes"
import { subSessionId } from "@/lib/claude/team-session-id"

function route(parentSessionId: string, rootSessionId?: string) {
  return {
    parentSessionId,
    ...(rootSessionId ? { rootSessionId } : {}),
    runId: `run-${parentSessionId}`,
    subagentId: "explore",
    backgrounded: false,
  }
}

afterEach(() => __clearAllSubagentApprovalRoutesForTesting())

describe("resolveRootSessionId", () => {
  it("returns an ordinary session unchanged", () => {
    expect(resolveRootSessionId("chat-1")).toBe("chat-1")
  })

  it("maps a team sub-session to its team session", () => {
    expect(resolveRootSessionId(subSessionId("team-1", "char-a", "turn-1"))).toBe("team-1")
  })

  it("maps a subagent session to the chat that dispatched it", () => {
    registerSubagentApprovalRoute("eph-1", route("chat-1"))
    expect(resolveRootSessionId("eph-1")).toBe("chat-1")
  })

  it("walks a three-level chain through live routes", () => {
    registerSubagentApprovalRoute("eph-child", route("chat-1"))
    registerSubagentApprovalRoute("eph-grandchild", route("eph-child"))
    expect(resolveRootSessionId("eph-grandchild")).toBe("chat-1")
  })

  it("uses the recorded root after the middle route is cleared", () => {
    registerSubagentApprovalRoute("eph-child", route("chat-1"))
    registerSubagentApprovalRoute("eph-grandchild", route("eph-child", "chat-1"))
    clearSubagentApprovalRoute("eph-child")
    expect(resolveRootSessionId("eph-grandchild")).toBe("chat-1")
  })

  it("resolves a subagent dispatched from a team member to the team", () => {
    const member = subSessionId("team-1", "char-a", "turn-1")
    registerSubagentApprovalRoute("eph-1", route(member))
    expect(resolveRootSessionId("eph-1")).toBe("team-1")
  })

  it("stops on a cycle instead of looping", () => {
    registerSubagentApprovalRoute("a", route("b"))
    registerSubagentApprovalRoute("b", route("a"))
    expect(["a", "b"]).toContain(resolveRootSessionId("a"))
  })
})
