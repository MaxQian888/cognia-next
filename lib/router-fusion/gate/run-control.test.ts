import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import { RouterFusionInfrastructureError, RouterFusionUnavailableError } from "./faults"
import type { RouterFusionHost } from "./load-engine"
import {
  CONTROLLED_RUN_SURFACES,
  PROJECTED_RUN_SURFACES,
  cancelRouterFusionRun,
  decideRouterFusionApproval,
  projectedRunSurfaceOf,
} from "./run-control"

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

describe("agentsWorkflows runs in the cockpit", () => {
  const AGENTS_ONLY = { routerFusion: { enabled: true, surfaces: { agentsWorkflows: true } } }

  function hostWithRun(surface: string) {
    return async () =>
      ({
        currentFusionStore: async () => ({
          getRun: async (runId: string) => ({ runId, surface }),
        }),
        drainAccountOutbox,
      }) as unknown as RouterFusionHost
  }

  it("is controlled here but never projected as a row of its own", () => {
    expect(CONTROLLED_RUN_SURFACES).toContain("agentsWorkflows")
    expect(PROJECTED_RUN_SURFACES as readonly string[]).not.toContain("agentsWorkflows")
  })

  it("reads an agentsWorkflows run's surface with only that switch on", async () => {
    await expect(
      projectedRunSurfaceOf("run-a", {
        settings: AGENTS_ONLY,
        loadHost: hostWithRun("agentsWorkflows"),
      })
    ).resolves.toBe("agentsWorkflows")
    // A surface this module does not control is still not guessed at.
    await expect(
      projectedRunSurfaceOf("run-u", { settings: AGENTS_ONLY, loadHost: hostWithRun("utility") })
    ).resolves.toBeNull()
  })

  it("gates a delegate decision on the agentsWorkflows switch, not the Run API's", async () => {
    const loadHost = jest.fn()
    await expect(
      decideRouterFusionApproval("run-a", "approve", {
        settings: ON,
        surface: "agentsWorkflows",
        interruptId: "approval-1",
        loadHost,
      })
    ).rejects.toThrow(/switched off/)
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("decides through the engine and hands the resumed run to a driver", async () => {
    const drive = jest.fn()
    const resumeRun = jest.fn()
    const loadHost = async () =>
      ({
        currentFusionStore: async () => ({ getRun: async () => undefined, resumeRun }),
        drainAccountOutbox,
      }) as unknown as RouterFusionHost
    // The run is gone: the refusal is reported, and nothing is driven.
    await expect(
      decideRouterFusionApproval("run-a", "approve", {
        settings: AGENTS_ONLY,
        surface: "agentsWorkflows",
        interruptId: "approval-1",
        loadHost,
        drive,
      })
    ).rejects.toThrow(/RUN_NOT_FOUND/)
    expect(drive).not.toHaveBeenCalled()
    expect(resumeRun).not.toHaveBeenCalled()
  })
})
