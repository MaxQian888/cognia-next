import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"
import {
  __resetHostDispatchDeliveriesForTesting,
  deliverHostDispatch,
  HostDispatchDeliveryError,
  registerHostDispatchDelivery,
} from "./host-dispatch-delivery"

const job: HostDispatchJobRow = {
  id: "dispatch-1",
  accountId: "account-1",
  domain: "schedule-handoff",
  targetRef: "host-1",
  kind: "workflow.trigger",
  payload: {},
  status: "pending",
  attempts: 0,
  maxAttempts: 3,
  createdAt: 1,
  updatedAt: 1,
  nextAttemptAt: 1,
  expiresAt: 10,
  idempotencyKey: "dispatch-1",
}

afterEach(__resetHostDispatchDeliveriesForTesting)

it("registers, dispatches, and unregisters one domain delivery", async () => {
  const delivery = jest.fn().mockResolvedValue("awaiting-result")
  const unregister = registerHostDispatchDelivery("schedule-handoff", delivery)

  await expect(deliverHostDispatch(job)).resolves.toBe("awaiting-result")
  expect(delivery).toHaveBeenCalledWith(job)

  unregister()
  await expect(deliverHostDispatch(job)).rejects.toMatchObject({
    code: "unsupported",
    retryable: false,
  })
})

it("keeps a replacement registered when the old disposer runs", async () => {
  const first = jest.fn().mockResolvedValue("succeeded")
  const second = jest.fn().mockResolvedValue("awaiting-result")
  const unregisterFirst = registerHostDispatchDelivery("schedule-handoff", first)
  registerHostDispatchDelivery("schedule-handoff", second)

  unregisterFirst()
  await expect(deliverHostDispatch(job)).resolves.toBe("awaiting-result")
  expect(first).not.toHaveBeenCalled()
})

it("preserves typed delivery failures", async () => {
  const failure = new HostDispatchDeliveryError("offline", true, "Host is offline")
  registerHostDispatchDelivery("schedule-handoff", jest.fn().mockRejectedValue(failure))

  await expect(deliverHostDispatch(job)).rejects.toBe(failure)
  expect(failure.name).toBe("HostDispatchDeliveryError")
})
