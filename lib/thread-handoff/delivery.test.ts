import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"

import { createThreadHandoffDelivery, registerThreadHandoffDelivery } from "./delivery"

const ticket = {
  ticketId: "ticket-1",
  role: "target",
  target: { hostRef: "phone-1" },
}
const envelope = { header: { canonicalVersion: 1 }, turns: [] }

function job(overrides: Partial<HostDispatchJobRow> = {}): HostDispatchJobRow {
  return {
    id: "ticket-1",
    accountId: "account-1",
    domain: "thread-handoff",
    targetRef: "phone-1",
    kind: "offer",
    payload: { ticket, envelope },
    status: "inflight",
    attempts: 0,
    maxAttempts: 6,
    createdAt: 1,
    updatedAt: 1,
    nextAttemptAt: 1,
    expiresAt: 2,
    idempotencyKey: "handoff-1",
    ...overrides,
  }
}

describe("thread-handoff delivery", () => {
  it("publishes the addressed offer and waits for the ownership result", async () => {
    const emit = jest.fn(async () => undefined)
    await expect(createThreadHandoffDelivery({ emit })(job())).resolves.toBe("awaiting-result")
    expect(emit).toHaveBeenCalledWith("thread-handoff://offer", { ticket, envelope })
  })

  it("rejects a target mismatch without emitting", async () => {
    const emit = jest.fn(async () => undefined)
    await expect(
      createThreadHandoffDelivery({ emit })(job({ targetRef: "other-phone" }))
    ).rejects.toMatchObject({ code: "malformed", retryable: false })
    expect(emit).not.toHaveBeenCalled()
  })

  describe("expiry sweep", () => {
    afterEach(() => {
      jest.useRealTimers()
    })

    it("runs the sweep on registration and on the interval, and stops on dispose", () => {
      // The sweep is the ONLY thing that retires an expired ticket. Unswept, a
      // ticket leaves its session's `handoffLock` set forever and every
      // ordinary write throws — so it shares the delivery's lifecycle.
      jest.useFakeTimers()
      const sweep = jest.fn(async () => undefined)
      const dispose = registerThreadHandoffDelivery({ sweep, sweepIntervalMs: 1000 })
      expect(sweep).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(2000)
      expect(sweep).toHaveBeenCalledTimes(3)

      dispose()
      jest.advanceTimersByTime(5000)
      expect(sweep).toHaveBeenCalledTimes(3)
    })

    it("keeps the delivery registered when a sweep fails", () => {
      jest.useFakeTimers()
      const sweep = jest.fn(async () => {
        throw new Error("no dexie on this host")
      })
      const dispose = registerThreadHandoffDelivery({ sweep, sweepIntervalMs: 1000 })
      expect(() => jest.advanceTimersByTime(1000)).not.toThrow()
      expect(sweep).toHaveBeenCalledTimes(2)
      dispose()
    })
  })
})
