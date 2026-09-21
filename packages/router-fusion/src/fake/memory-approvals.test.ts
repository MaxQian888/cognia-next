import type { DelegateApprovalRequest } from "../workflows/delegate-ports"
import { MemoryApprovalPort } from "./memory-approvals"

function request(digest: string): DelegateApprovalRequest {
  return {
    runId: "run-1",
    logicalStepId: "delegate:work:1:turn:1:scope",
    kind: "scope_expansion",
    requestDigest: digest,
    revision: "rev-0",
    args: { paths: ["config/app.json"] },
    summary: { paths: ["config/app.json"], fileCount: 1, patchSha256: null, patchArtifactId: null },
    requestedBy: "worker",
  }
}

describe("MemoryApprovalPort", () => {
  it("waits until a person decides, and answers idempotently per digest", async () => {
    const port = new MemoryApprovalPort()
    const first = await port.requestApproval(request("d1"))
    expect(first).toMatchObject({ status: "waiting", requestDigest: "d1" })
    expect(await port.requestApproval(request("d1"))).toEqual(first)
    expect(port.statusOf("d1")).toBe("waiting")

    port.decide("d1", "approved")
    expect(await port.requestApproval(request("d1"))).toEqual({
      status: "approved",
      approvalId: first.approvalId,
      requestDigest: "d1",
    })
    // Another digest is another request, whatever the paths look like.
    expect(await port.requestApproval(request("d2"))).toMatchObject({ status: "waiting" })
    expect(port.requests).toHaveLength(4)
    expect(port.statusOf("nope")).toBeNull()
  })

  it("records a denial with its reason and never re-decides a decided request", async () => {
    const port = new MemoryApprovalPort()
    await port.requestApproval(request("d1"))
    port.decide("d1", "denied", "not this directory")
    expect(await port.requestApproval(request("d1"))).toMatchObject({
      status: "denied",
      reason: "not this directory",
    })
    expect(() => port.decide("d1", "approved")).toThrow("already denied")
    expect(() => port.decide("unknown", "approved")).toThrow("no approval request")
  })

  it("lets a policy stand in for a person who answers at once", async () => {
    const port = new MemoryApprovalPort((r) =>
      r.kind === "scope_expansion" ? "denied" : undefined
    )
    expect(await port.requestApproval(request("d1"))).toMatchObject({
      status: "denied",
      reason: null,
    })
    expect(await port.requestApproval({ ...request("d2"), kind: "workspace_apply" })).toMatchObject(
      { status: "waiting" }
    )
  })
})
