import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import {
  NEEDS_APPROVAL_STATUS,
  createUnattendedPermissionResponder,
  needsApprovalSummary,
  unattendedDenialMessage,
} from "./unattended-permission-responder"

function request(toolName: string, requestId = `req-${toolName}`): PermissionRequestEvent {
  return {
    type: "permission_request",
    sessionId: "s1",
    requestId,
    toolName,
    input: {},
  } as PermissionRequestEvent
}

describe("createUnattendedPermissionResponder", () => {
  it("denies every request immediately and tells the model why", () => {
    const responder = createUnattendedPermissionResponder("bot", { now: () => 42 })
    const decision = responder.onPermissionRequest(request("Edit"))
    expect(decision.decision).toBe("deny")
    expect(decision.message).toBe(unattendedDenialMessage("bot", "Edit"))
    expect(decision.message).toContain(NEEDS_APPROVAL_STATUS)
    expect(decision.message).toContain("Do not retry it")
    expect(responder.denials).toEqual([
      { requestId: "req-Edit", toolName: "Edit", at: 42, reason: decision.message },
    ])
  })

  it("starts with nothing to approve and flips once a tool is denied", () => {
    const responder = createUnattendedPermissionResponder("plugin")
    expect(responder.needsApproval()).toBe(false)
    expect(responder.deniedToolNames()).toEqual([])
    responder.onPermissionRequest(request("Bash", "r1"))
    responder.onPermissionRequest(request("Bash", "r2"))
    responder.onPermissionRequest(request("Write", "r3"))
    expect(responder.needsApproval()).toBe(true)
    expect(responder.deniedToolNames()).toEqual(["Bash", "Write"])
    expect(responder.denials).toHaveLength(3)
  })

  it("summarises the denied tools on one line for run lists", () => {
    const responder = createUnattendedPermissionResponder("scheduled task")
    responder.onPermissionRequest(request("Edit"))
    responder.onPermissionRequest(request("Bash"))
    expect(needsApprovalSummary(responder)).toBe("needs approval: Edit, Bash")
  })

  it("never returns an updatedInput: a denial is a denial", () => {
    const responder = createUnattendedPermissionResponder("plugin")
    expect(responder.onPermissionRequest(request("Edit")).updatedInput).toBeUndefined()
  })
})
