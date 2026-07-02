import {
  approvalId,
  approvalWakeKey,
  getPendingApproval,
  listPendingApprovals,
  registerPendingApproval,
  removePendingApproval,
  respondToApproval,
  subscribePendingApprovals,
  __resetApprovalRegistryForTesting,
  type PendingApproval,
} from "./approval-registry"
import { subscribeWake, _clearWakeBusForTest } from "./wake-bus"

function entry(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: approvalId("run_1", "n_gate"),
    runId: "run_1",
    workflowId: "wf_1",
    stepId: "n_gate",
    title: "Deploy to prod?",
    requestedAt: 1_000,
    ...overrides,
  }
}

afterEach(() => {
  __resetApprovalRegistryForTesting()
  _clearWakeBusForTest()
})

describe("approval registry", () => {
  it("registers, lists (oldest first), gets, and removes", () => {
    registerPendingApproval(entry({ approvalId: "apr_b", requestedAt: 2_000 }))
    registerPendingApproval(entry({ approvalId: "apr_a", requestedAt: 1_000 }))
    expect(listPendingApprovals().map((e) => e.approvalId)).toEqual(["apr_a", "apr_b"])
    expect(getPendingApproval("apr_a")?.title).toBe("Deploy to prod?")
    removePendingApproval("apr_a")
    expect(getPendingApproval("apr_a")).toBeUndefined()
  })

  it("notifies subscribers on register and remove", () => {
    const fn = jest.fn()
    const off = subscribePendingApprovals(fn)
    registerPendingApproval(entry())
    removePendingApproval(entry().approvalId)
    expect(fn).toHaveBeenCalledTimes(2)
    off()
    registerPendingApproval(entry())
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("respondToApproval wakes the waiting executor with the response", async () => {
    const e = entry()
    registerPendingApproval(e)
    const wait = subscribeWake(approvalWakeKey(e.runId, e.stepId))
    const result = respondToApproval(e.approvalId, {
      decision: "approved",
      respondedBy: "device:dev-7",
    })
    expect(result).toEqual({ ok: true })
    await expect(wait).resolves.toMatchObject({
      source: "approval",
      data: { decision: "approved", respondedBy: "device:dev-7" },
    })
  })

  it("returns not-found for unknown ids", () => {
    expect(respondToApproval("apr_nope", { decision: "approved", respondedBy: "desktop" })).toEqual(
      { ok: false, reason: "not-found" }
    )
  })

  it("drops a stale entry with no live waiter and reports not-found", () => {
    const e = entry()
    registerPendingApproval(e)
    // No subscribeWake — simulates a dead executor.
    const result = respondToApproval(e.approvalId, { decision: "rejected", respondedBy: "desktop" })
    expect(result).toEqual({ ok: false, reason: "not-found" })
    expect(getPendingApproval(e.approvalId)).toBeUndefined()
  })
})
