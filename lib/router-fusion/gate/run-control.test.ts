import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import { RouterFusionInfrastructureError, RouterFusionUnavailableError } from "./faults"
import type { RouterFusionHost } from "./load-engine"
import { cancelRouterFusionRun } from "./run-control"

const ON = { routerFusion: { enabled: true, surfaces: { gatewayRuns: true } } }
const OFF = { routerFusion: { enabled: false, surfaces: { gatewayRuns: true } } }
const TRIPPED = {
  routerFusion: {
    enabled: true,
    surfaces: { gatewayRuns: true },
    trippedSurfaces: { gatewayRuns: { trippedAt: 1 } },
  },
}

const drainAccountOutbox = jest.fn(async () => ({ applied: 1, skipped: 0, failed: 0 }))

function fakeHost(cancelRun: jest.Mock) {
  return {
    currentFusionStore: async () => ({ cancelRun }),
    drainAccountOutbox,
  } as unknown as RouterFusionHost
}

beforeEach(() => {
  __resetBreakerForTesting()
  drainAccountOutbox.mockClear()
})

describe("cancelRouterFusionRun", () => {
  it("cancels through the engine and reports that it found the run", async () => {
    const cancelRun = jest.fn().mockResolvedValue({ runId: "run-1", status: "cancelled" })
    await expect(
      cancelRouterFusionRun("run-1", { settings: ON, loadHost: async () => fakeHost(cancelRun) })
    ).resolves.toBe(true)
    expect(cancelRun).toHaveBeenCalledWith("run-1")
    // A queued run is sealed here with no worker left to drain the seal, so the
    // cockpit row is updated now rather than staying "queued".
    expect(drainAccountOutbox).toHaveBeenCalledTimes(1)
  })

  it("stops a chat cascade or panel under the chat surface, not the Run API's", async () => {
    const cancelRun = jest.fn().mockResolvedValue({ runId: "chat-run", status: "cancelling" })
    const chatOnly = { routerFusion: { enabled: true, surfaces: { chat: true } } }
    await expect(
      cancelRouterFusionRun("chat-run", {
        settings: chatOnly,
        surface: "chat",
        loadHost: async () => fakeHost(cancelRun),
      })
    ).resolves.toBe(true)
    // The same run cannot be stopped as a Run API run while that surface is off.
    await expect(
      cancelRouterFusionRun("chat-run", {
        settings: chatOnly,
        loadHost: async () => fakeHost(cancelRun),
      })
    ).rejects.toThrow(/switched off/)
    expect(cancelRun).toHaveBeenCalledTimes(1)
  })

  it("still reports the cancel when the cockpit update cannot be applied yet", async () => {
    const cancelRun = jest.fn().mockResolvedValue({ runId: "run-1", status: "cancelled" })
    drainAccountOutbox.mockRejectedValueOnce(new Error("account database busy"))
    await expect(
      cancelRouterFusionRun("run-1", { settings: ON, loadHost: async () => fakeHost(cancelRun) })
    ).resolves.toBe(true)
  })

  it("reports a run the engine no longer has rather than claiming a cancel", async () => {
    const cancelRun = jest.fn().mockResolvedValue(undefined)
    await expect(
      cancelRouterFusionRun("gone", { settings: ON, loadHost: async () => fakeHost(cancelRun) })
    ).resolves.toBe(false)
    expect(drainAccountOutbox).not.toHaveBeenCalled()
  })

  it("[ACC:OFF-03] loads nothing while the surface is off", async () => {
    const loadHost = jest.fn()
    await expect(
      cancelRouterFusionRun("run-1", {
        settings: OFF,
        loadHost: loadHost as unknown as () => Promise<RouterFusionHost>,
      })
    ).rejects.toThrow(/switched off/)
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("[ACC:ISO-03] refuses on a tripped surface and fails explicitly on a fault", async () => {
    const loadHost = jest.fn()
    await expect(
      cancelRouterFusionRun("run-1", {
        settings: TRIPPED,
        loadHost: loadHost as unknown as () => Promise<RouterFusionHost>,
      })
    ).rejects.toBeInstanceOf(RouterFusionUnavailableError)
    expect(loadHost).not.toHaveBeenCalled()

    // Pressing stop is explicitly chosen fusion work: it never falls back to
    // "nothing happened", and the fault still moves the breaker.
    await expect(
      cancelRouterFusionRun("run-1", {
        settings: ON,
        loadHost: async () => {
          throw new RouterFusionInfrastructureError("db_unavailable", "blocked")
        },
      })
    ).rejects.toBeInstanceOf(RouterFusionUnavailableError)
    expect(getBreakerSnapshot("gatewayRuns").consecutiveFaults).toBe(1)
  })
})
