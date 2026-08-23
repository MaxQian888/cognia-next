import {
  deliverHostDispatch,
  __resetHostDispatchDeliveriesForTesting,
} from "@/lib/placement/host-dispatch-delivery"
import { registerMobileStepHostDelivery } from "./mobile-step-delivery"

afterEach(() => __resetHostDispatchDeliveriesForTesting())

it("publishes full execute data only on authenticated WS and IDs-only push", async () => {
  const frames: Array<{ event: string; payload: unknown }> = []
  registerMobileStepHostDelivery({
    emit: async (event, payload) => {
      frames.push({ event, payload })
    },
  })
  const request = {
    requestId: "rst-1",
    targetDeviceId: "phone-1",
    kind: "action.mobile.location",
    params: { secret: "precise-location-options" },
    runId: "run-1",
    stepId: "step-1",
    workflowId: "wf-1",
    issuedAt: 1,
    timeoutAt: 10,
  }
  await expect(
    deliverHostDispatch({
      id: "rst-1",
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone-1",
      kind: request.kind,
      payload: request,
      status: "inflight",
      attempts: 0,
      maxAttempts: 6,
      createdAt: 1,
      updatedAt: 1,
      nextAttemptAt: 1,
      expiresAt: 10,
      idempotencyKey: "stable",
    })
  ).resolves.toBe("awaiting-result")
  expect(frames[0]?.payload).toEqual(request)
  expect(frames[1]?.payload).toEqual({
    requestId: "rst-1",
    runId: "run-1",
    workflowId: "wf-1",
    targetDeviceId: "phone-1",
  })
  expect(JSON.stringify(frames[1]?.payload)).not.toContain("precise-location-options")
})
