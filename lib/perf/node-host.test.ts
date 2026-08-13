/** @jest-environment node */
import { NodePerformanceHost, type NodePerformanceProvider } from "./node-host"

let wall = 1_000
let monotonic = 0
let cpu = 0

const provider: NodePerformanceProvider = {
  nowWallMs: () => wall,
  nowMonotonicMs: () => monotonic,
  collect: async () => ({
    cpuUserMicros: cpu,
    cpuSystemMicros: 0,
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 4,
    arrayBuffersBytes: 2,
    eventLoopUtilization: 0.25,
    eventLoopDelayP95Ms: 3,
  }),
}

const request = (deviceId = "device-a", purpose: "live" | "capture" = "live") => ({
  clientId: `client-${deviceId}`,
  deviceId,
  targetId: "target-a",
  routingGeneration: 3,
  purpose,
  requestedCadenceMs: 500,
})

describe("NodePerformanceHost", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    wall = 1_000
    monotonic = 0
    cpu = 0
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("enforces remote admission, ownership, and immediate close", async () => {
    const host = new NodePerformanceHost(provider, { emit: jest.fn() })
    await expect(host.open({ ...request(), requestedCadenceMs: 250 })).resolves.toMatchObject({
      accepted: false,
      code: "cadence-too-fast",
    })
    const opened = await host.open(request())
    expect(opened.accepted).toBe(true)
    if (!opened.accepted) throw new Error("expected lease")
    await expect(host.snapshot(opened.lease.leaseId, "device-b")).rejects.toThrow(
      /permission-denied/
    )
    await host.close(opened.lease.leaseId, "device-a")
    await expect(host.snapshot(opened.lease.leaseId)).rejects.toThrow(/lease-expired/)
  })

  it("samples only with demand and dispatches separately per lease cadence", async () => {
    const emit = jest.fn()
    const host = new NodePerformanceHost(provider, { emit })
    const fast = await host.open(request("fast"))
    wall += 200
    const slow = await host.open({ ...request("slow"), requestedCadenceMs: 1_000 })
    if (!fast.accepted || !slow.accepted) throw new Error("expected leases")

    for (let index = 0; index < 3; index += 1) {
      wall += 500
      monotonic += 500
      cpu += 50_000
      await jest.advanceTimersByTimeAsync(500)
    }

    const fastSnapshot = await host.snapshot(fast.lease.leaseId)
    const slowSnapshot = await host.snapshot(slow.lease.leaseId)
    expect(fastSnapshot.frames).toHaveLength(3)
    expect(slowSnapshot.frames).toHaveLength(2)
    expect(fastSnapshot.frames[0].observations?.["node.cpu.utilization.pct"]).toBeNull()
    expect(fastSnapshot.frames[1].observations?.["node.cpu.utilization.pct"]).toBe(10)
    expect(emit).toHaveBeenCalledWith("fast", expect.objectContaining({ requestedIntervalMs: 500 }))
    expect(emit).toHaveBeenCalledWith(
      "slow",
      expect.objectContaining({ requestedIntervalMs: 1_000 })
    )
    await host.stop()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("expires an abnormal disconnect after the 15 second TTL", async () => {
    const host = new NodePerformanceHost(provider, { emit: jest.fn() })
    const opened = await host.open(request())
    if (!opened.accepted) throw new Error("expected lease")
    wall += 15_000
    await expect(host.renew(opened.lease.leaseId)).rejects.toThrow(/lease-expired/)
    await host.stop()
  })

  it("rate limits remote renewals without shortening the prior TTL", async () => {
    const host = new NodePerformanceHost(provider, { emit: jest.fn() })
    const opened = await host.open(request())
    if (!opened.accepted) throw new Error("expected lease")
    wall += 5_000
    await host.renew(opened.lease.leaseId, "device-a")
    wall += 50
    await expect(host.renew(opened.lease.leaseId, "device-a")).rejects.toThrow(/rate-limited/)
    wall += 100
    await expect(host.renew(opened.lease.leaseId, "device-a")).resolves.toBeUndefined()
    await host.stop()
  })
})
