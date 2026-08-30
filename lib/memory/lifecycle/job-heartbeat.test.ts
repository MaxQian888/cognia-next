const mockHeartbeat = jest.fn()

import { startMemoryJobHeartbeat } from "./job-heartbeat"

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockHeartbeat.mockResolvedValue({ id: "j1" })
})
afterEach(() => jest.useRealTimers())

/** Let the renew promise settle between timer ticks. */
async function tick(ms: number) {
  jest.advanceTimersByTime(ms)
  await Promise.resolve()
  await Promise.resolve()
}

describe("startMemoryJobHeartbeat", () => {
  it("renews on schedule for as long as it owns the job", async () => {
    const stop = startMemoryJobHeartbeat("j1", "w1", {
      heartbeat: mockHeartbeat as never,
      intervalMs: 100,
      now: () => 1_000,
    })
    await tick(100)
    expect(mockHeartbeat).toHaveBeenCalledWith("j1", "w1", 1_000)
    await tick(100)
    expect(mockHeartbeat).toHaveBeenCalledTimes(2)
    stop()
  })

  it("defaults its period to a third of the lease so a renew always precedes expiry", async () => {
    const { MEMORY_JOB_LEASE_TTL_MS } = jest.requireActual("@/lib/db/memory-governance") as {
      MEMORY_JOB_LEASE_TTL_MS: number
    }
    const stop = startMemoryJobHeartbeat("j1", "w1", { heartbeat: mockHeartbeat as never })
    await tick(Math.floor(MEMORY_JOB_LEASE_TTL_MS / 3))
    expect(mockHeartbeat).toHaveBeenCalledTimes(1)
    stop()
  })

  it("stops and reports when the fence refuses the renew", async () => {
    mockHeartbeat.mockResolvedValue(undefined)
    const onLeaseLost = jest.fn()
    startMemoryJobHeartbeat("j1", "w1", {
      heartbeat: mockHeartbeat as never,
      intervalMs: 100,
      onLeaseLost,
    })
    await tick(100)
    expect(onLeaseLost).toHaveBeenCalledTimes(1)
    await tick(500)
    expect(mockHeartbeat).toHaveBeenCalledTimes(1)
  })

  it("treats a thrown renew as a lost lease", async () => {
    mockHeartbeat.mockRejectedValue(new Error("db down"))
    const onLeaseLost = jest.fn()
    startMemoryJobHeartbeat("j1", "w1", {
      heartbeat: mockHeartbeat as never,
      intervalMs: 100,
      onLeaseLost,
    })
    await tick(100)
    expect(onLeaseLost).toHaveBeenCalledTimes(1)
  })

  it("stops cleanly and is safe to call twice", async () => {
    const stop = startMemoryJobHeartbeat("j1", "w1", {
      heartbeat: mockHeartbeat as never,
      intervalMs: 100,
    })
    stop()
    stop()
    await tick(500)
    expect(mockHeartbeat).not.toHaveBeenCalled()
  })
})
