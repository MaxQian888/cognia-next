import "fake-indexeddb/auto"

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getWorkflowWaitpoint } from "@/lib/db/workflow-waitpoints"
import { getActionReviewReceipt } from "@/lib/db/action-review-receipts"
import {
  approvalId,
  getPendingApproval,
  listPendingApprovals,
  registerPendingApproval,
  respondToApproval,
  subscribePendingApprovals,
  __resetApprovalRegistryForTesting,
  type PendingApproval,
} from "./approval-registry"

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

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await __resetApprovalRegistryForTesting()
})
afterAll(dbFixture.dispose)

describe("durable approval registry", () => {
  it("registers, lists oldest first, and gets pending approvals", async () => {
    await registerPendingApproval(entry({ approvalId: "apr_b", requestedAt: 2_000 }))
    await registerPendingApproval(entry({ approvalId: "apr_a", requestedAt: 1_000 }))
    expect((await listPendingApprovals()).map((approval) => approval.approvalId)).toEqual([
      "apr_a",
      "apr_b",
    ])
    await expect(getPendingApproval("apr_a")).resolves.toMatchObject({
      title: "Deploy to prod?",
    })
  })

  it("notifies subscribers on registration and decision", async () => {
    const listener = jest.fn()
    const off = subscribePendingApprovals(listener)
    await registerPendingApproval(entry())
    await respondToApproval(entry().approvalId, {
      decision: "approved",
      respondedBy: "desktop",
    })
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    await registerPendingApproval(entry({ approvalId: "apr_2" }))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("accepts an offline device response without a live executor", async () => {
    const approval = entry()
    await registerPendingApproval(approval)
    await expect(
      respondToApproval(approval.approvalId, {
        decision: "approved",
        respondedBy: "device:dev-7",
      })
    ).resolves.toEqual({ ok: true })
    await expect(getPendingApproval(approval.approvalId)).resolves.toBeUndefined()
    await expect(getWorkflowWaitpoint(approval.approvalId)).resolves.toMatchObject({
      status: "resolved",
      resolution: { outcome: "approved", respondedBy: "device:dev-7" },
    })
    await expect(getActionReviewReceipt(approval.approvalId)).resolves.toMatchObject({
      runId: "run_1",
      channel: "workflow-step",
      outcome: "allow",
      authority: "human",
      decision: { actor: { kind: "device", id: "dev-7" } },
    })
  })

  it("returns not-found for unknown ids", async () => {
    await expect(
      respondToApproval("apr_nope", { decision: "approved", respondedBy: "desktop" })
    ).resolves.toEqual({ ok: false, reason: "not-found" })
  })

  it("rejects a duplicate device decision without changing the first", async () => {
    const approval = entry()
    await registerPendingApproval(approval)
    await respondToApproval(approval.approvalId, {
      decision: "approved",
      respondedBy: "device:first",
    })
    await expect(
      respondToApproval(approval.approvalId, {
        decision: "rejected",
        respondedBy: "device:second",
      })
    ).resolves.toEqual({ ok: false, reason: "already-decided" })
    await expect(getWorkflowWaitpoint(approval.approvalId)).resolves.toMatchObject({
      resolution: { outcome: "approved", respondedBy: "device:first" },
    })
  })
})
