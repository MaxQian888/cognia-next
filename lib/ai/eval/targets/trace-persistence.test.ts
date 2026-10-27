jest.mock("@cognia/logging/core", () => ({ getTransport: jest.fn() }))

import { getTransport } from "@cognia/logging/core"
import { waitForEvalTracePersistence } from "./trace-persistence"

it("waits for the acknowledgement from an already-started trace write", async () => {
  let acknowledge!: () => void
  let settled = false
  const writing = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  jest.mocked(getTransport).mockReturnValue({
    name: "agent-trace",
    log: jest.fn(),
    flush: () => writing,
  })
  const pending = waitForEvalTracePersistence().then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  acknowledge()
  await pending
  expect(settled).toBe(true)
})

it("does not claim a failed write was a completed trace", async () => {
  jest.mocked(getTransport).mockReturnValue({
    name: "agent-trace",
    log: jest.fn(),
    flush: async () => undefined,
    getHealth: () => ({
      transport: "agent-trace",
      status: "degraded",
      queueDepth: 0,
      retryCount: 0,
      droppedEntries: 1,
      lastError: "disk unavailable",
      updatedAt: "2026-10-24",
    }),
  })
  await expect(waitForEvalTracePersistence()).rejects.toThrow("disk unavailable")
})

it("allows capture-disabled hosts to report unavailable measurements", async () => {
  jest.mocked(getTransport).mockReturnValue(undefined)
  await expect(waitForEvalTracePersistence()).resolves.toBeUndefined()
})
