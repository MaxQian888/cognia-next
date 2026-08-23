import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"
import {
  __resetHostDispatchDeliveriesForTesting,
  deliverHostDispatch,
} from "@/lib/placement/host-dispatch-delivery"
import {
  createScheduleHandoffDelivery,
  registerScheduleHandoffDelivery,
  type WorkflowScheduleHandoffPayload,
} from "./schedule-handoff-delivery"

function job(payload: Partial<WorkflowScheduleHandoffPayload> = {}): HostDispatchJobRow {
  return {
    id: "dispatch-1",
    accountId: "account-1",
    domain: "schedule-handoff",
    targetRef: "cloud-a",
    kind: "workflow.trigger",
    payload: {
      deploymentId: "deployment-1",
      expectedVersionDigest: "wfv1:abc",
      trigger: {
        workflowId: "workflow-1",
        kind: "trigger.cron",
        originAt: 123,
        payload: { scheduledAt: 123 },
      },
      ...payload,
    },
    status: "inflight",
    attempts: 0,
    maxAttempts: 6,
    createdAt: 100,
    updatedAt: 100,
    nextAttemptAt: 100,
    expiresAt: 1_000,
    idempotencyKey: "workflow-trigger:workflow-1:123",
  }
}

describe("createScheduleHandoffDelivery", () => {
  afterEach(__resetHostDispatchDeliveriesForTesting)

  it("delivers the exact deployment and trigger over an isolated target transport", async () => {
    const call = jest.fn().mockResolvedValue({ runId: "run-remote", status: "accepted" })
    const close = jest.fn()
    const openTarget = jest.fn().mockResolvedValue({ transport: { call }, close })
    const delivery = createScheduleHandoffDelivery({ openTarget })

    await expect(delivery(job())).resolves.toBe("succeeded")

    expect(openTarget).toHaveBeenCalledWith("cloud-a")
    expect(call).toHaveBeenCalledWith(
      "workflow_handoff_create",
      expect.objectContaining({
        deploymentId: "deployment-1",
        expectedVersionDigest: "wfv1:abc",
        idempotencyKey: "workflow-trigger:workflow-1:123",
      }),
      { idempotencyKey: "workflow-trigger:workflow-1:123" }
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("closes the isolated transport and marks connection failures retryable", async () => {
    const close = jest.fn()
    const openTarget = jest.fn().mockResolvedValue({
      transport: { call: jest.fn().mockRejectedValue(new Error("offline")) },
      close,
    })
    const delivery = createScheduleHandoffDelivery({ openTarget })

    await expect(delivery(job())).rejects.toMatchObject({
      code: "handoff_failed",
      retryable: true,
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("rejects malformed durable rows without contacting a target", async () => {
    const openTarget = jest.fn()
    const delivery = createScheduleHandoffDelivery({ openTarget })

    await expect(delivery(job({ expectedVersionDigest: "" }))).rejects.toMatchObject({
      code: "malformed",
      retryable: false,
    })
    expect(openTarget).not.toHaveBeenCalled()
  })

  it("normalizes non-Error failures and leaves unopened transports alone", async () => {
    const delivery = createScheduleHandoffDelivery({
      openTarget: jest.fn().mockRejectedValue("offline"),
    })

    await expect(delivery(job())).rejects.toMatchObject({
      message: "workflow handoff failed: offline",
      retryable: true,
    })
  })

  it("registers and unregisters the schedule handoff domain adapter", async () => {
    const call = jest.fn().mockResolvedValue({ runId: "run-remote" })
    const unregister = registerScheduleHandoffDelivery({
      openTarget: jest.fn().mockResolvedValue({ transport: { call }, close: jest.fn() }),
    })

    await expect(deliverHostDispatch(job())).resolves.toBe("succeeded")
    unregister()
    await expect(deliverHostDispatch(job())).rejects.toMatchObject({ code: "unsupported" })
  })
})
