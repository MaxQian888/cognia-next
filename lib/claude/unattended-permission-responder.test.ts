import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { UnattendedPark } from "./unattended-park"
import {
  NEEDS_APPROVAL_STATUS,
  createUnattendedPermissionResponder,
  needsApprovalSummary,
  unattendedDenialMessage,
  unattendedRefusalMessage,
  unattendedTimeoutMessage,
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
  it("denies every request immediately and tells the model why", async () => {
    const responder = createUnattendedPermissionResponder("bot", { now: () => 42 })
    expect(responder.parks).toBe(false)
    const decision = await responder.onPermissionRequest(request("Edit"))
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

  it("never returns an updatedInput: a denial is a denial", async () => {
    const responder = createUnattendedPermissionResponder("plugin")
    expect((await responder.onPermissionRequest(request("Edit"))).updatedInput).toBeUndefined()
  })
})

describe("createUnattendedPermissionResponder with a park (ADR-0224 A7)", () => {
  function park(outcome: Awaited<ReturnType<UnattendedPark["park"]>> | Error): UnattendedPark {
    return {
      park: jest.fn(async () => {
        if (outcome instanceof Error) throw outcome
        return outcome
      }),
      finish: jest.fn(async () => undefined),
      runId: () => "run-1",
    }
  }

  it("resumes the turn with the approver's decision", async () => {
    const responder = createUnattendedPermissionResponder("bot", {
      park: park({ kind: "approved", decision: { decision: "allow", updatedInput: { a: 1 } } }),
    })
    expect(responder.parks).toBe(true)
    await expect(responder.onPermissionRequest(request("Edit"))).resolves.toEqual({
      decision: "allow",
      updatedInput: { a: 1 },
    })
    expect(responder.needsApproval()).toBe(false)
  })

  it("passes on a person's denial without marking the run as needing approval", async () => {
    const responder = createUnattendedPermissionResponder("bot", {
      now: () => 7,
      park: park({ kind: "denied", message: "not now" }),
    })
    await expect(responder.onPermissionRequest(request("Edit"))).resolves.toEqual({
      decision: "deny",
      message: unattendedRefusalMessage("Edit", "not now"),
    })
    expect(responder.needsApproval()).toBe(false)
    expect(responder.refusals).toEqual([{ requestId: "req-Edit", toolName: "Edit", at: 7 }])
  })

  it("records an unanswered question as needing approval", async () => {
    for (const kind of ["expired", "withdrawn"] as const) {
      const responder = createUnattendedPermissionResponder("scheduled task", {
        park: park({ kind }),
      })
      const decision = await responder.onPermissionRequest(request("Bash"))
      expect(decision).toEqual({
        decision: "deny",
        message: unattendedTimeoutMessage("scheduled task", "Bash"),
      })
      expect(responder.needsApproval()).toBe(true)
      expect(needsApprovalSummary(responder)).toBe("needs approval: Bash")
    }
  })

  it("falls back to an immediate denial when parking itself fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const responder = createUnattendedPermissionResponder("bot", {
      park: park(new Error("no database")),
    })
    await expect(responder.onPermissionRequest(request("Edit"))).resolves.toEqual({
      decision: "deny",
      message: unattendedDenialMessage("bot", "Edit"),
    })
    expect(responder.needsApproval()).toBe(true)
    warn.mockRestore()
  })

  it("closes the parked run through the park", async () => {
    const parking = park({ kind: "expired" })
    const responder = createUnattendedPermissionResponder("bot", { park: parking })
    await responder.finish("completed", "done")
    expect(parking.finish).toHaveBeenCalledWith("completed", "done")
    await expect(createUnattendedPermissionResponder("bot").finish("failed")).resolves.toBe(
      undefined
    )
  })
})
