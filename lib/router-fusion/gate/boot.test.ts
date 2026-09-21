import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import {
  ROUTER_FUSION_RETENTION_INTERVAL_MS,
  pruneRouterFusionData,
  recoverRouterFusionRuns,
  startRouterFusionRetention,
} from "./boot"
import { RouterFusionInfrastructureError } from "./faults"
import type { RouterFusionHost } from "./load-engine"

const on = { routerFusion: { enabled: true, surfaces: { chat: true } } }

describe("recoverRouterFusionRuns", () => {
  afterEach(() => __resetBreakerForTesting())

  it("[ACC:OFF-03] loads nothing and opens no database while chat is off", async () => {
    const loadHost = jest.fn()
    await expect(recoverRouterFusionRuns(undefined, loadHost)).resolves.toBeNull()
    await expect(
      recoverRouterFusionRuns(
        { routerFusion: { enabled: true, surfaces: { chat: false } } },
        loadHost
      )
    ).resolves.toBeNull()
    await expect(
      recoverRouterFusionRuns(
        { routerFusion: { enabled: false, surfaces: { chat: true } } },
        loadHost
      )
    ).resolves.toBeNull()
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("sweeps the chat runs earlier windows left behind", async () => {
    const deps = { leaseOwner: "window:x" }
    const recoverStaleFusionRuns = jest.fn().mockResolvedValue(2)
    const chatRunDeps = jest.fn().mockReturnValue(deps)
    const resume = jest.fn()
    const orchestratedRunResumer = jest.fn().mockReturnValue(resume)
    const host = {
      recoverStaleFusionRuns,
      chatRunDeps,
      orchestratedRunResumer,
    } as unknown as RouterFusionHost
    await expect(recoverRouterFusionRuns(on, async () => host)).resolves.toBe(2)
    expect(recoverStaleFusionRuns).toHaveBeenCalledWith({ ...deps, resumeOrchestrated: resume })
    // Only the surfaces that are on may have their runs carried on.
    expect(orchestratedRunResumer).toHaveBeenCalledWith(on, ["chat"])
  })

  it("sweeps for any wired surface, not only chat", async () => {
    const recoverStaleFusionRuns = jest.fn().mockResolvedValue(1)
    const host = {
      recoverStaleFusionRuns,
      chatRunDeps: jest.fn().mockReturnValue({}),
      orchestratedRunResumer: jest.fn().mockReturnValue(() => false),
    } as unknown as RouterFusionHost
    const utilities = { routerFusion: { enabled: true, surfaces: { utilityLedger: true } } }
    await expect(recoverRouterFusionRuns(utilities, async () => host)).resolves.toBe(1)
    // The companion surface is wired since WP-C: a run a paired phone started
    // and a closed window left behind is swept and carried on like any other.
    const companion = { routerFusion: { enabled: true, surfaces: { companion: true } } }
    await expect(recoverRouterFusionRuns(companion, async () => host)).resolves.toBe(1)
    expect(host.orchestratedRunResumer).toHaveBeenLastCalledWith(companion, ["companion"])
    // A surface this build does not declare, switched on in stored settings,
    // still sweeps nothing: only wired switches count.
    const loadHost = jest.fn()
    await expect(
      recoverRouterFusionRuns(
        { routerFusion: { enabled: true, surfaces: { notASurface: true } } } as never,
        loadHost
      )
    ).resolves.toBeNull()
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("counts a recovery fault against every live surface", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const both = {
      routerFusion: { enabled: true, surfaces: { chat: true, gatewayRuns: true } },
    }
    await recoverRouterFusionRuns(both, async () => {
      throw new RouterFusionInfrastructureError("db_unavailable", "blocked")
    })
    // One database, one sweep: the fault is every live surface's problem.
    expect(getBreakerSnapshot("chat").lastFault?.code).toBe("db_unavailable")
    expect(getBreakerSnapshot("gatewayRuns").lastFault?.code).toBe("db_unavailable")
    expect(getBreakerSnapshot("utilityLedger").lastFault).toBeNull()
    warn.mockRestore()
  })

  it("[ACC:ISO-01] counts a fault instead of failing the boot", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await expect(
      recoverRouterFusionRuns(on, async () => {
        throw new RouterFusionInfrastructureError("db_unavailable", "blocked")
      })
    ).resolves.toBeNull()
    expect(getBreakerSnapshot("chat").lastFault?.code).toBe("db_unavailable")
    warn.mockRestore()
  })

  it("does not sweep a tripped surface", async () => {
    const loadHost = jest.fn()
    await recoverRouterFusionRuns(
      { routerFusion: { ...on.routerFusion, trippedSurfaces: { chat: { trippedAt: 1 } } } },
      loadHost
    )
    expect(loadHost).not.toHaveBeenCalled()
  })
})

describe("Router + Fusion retention schedule", () => {
  const report = { runs: 1, artifacts: 0 }

  function fakeHost() {
    const db = { name: "fusion" }
    const pruneFusionDatabase = jest.fn().mockResolvedValue(report)
    const currentFusionStore = jest.fn().mockResolvedValue({ db })
    return {
      db,
      pruneFusionDatabase,
      host: { pruneFusionDatabase, currentFusionStore } as unknown as RouterFusionHost,
    }
  }

  it("[ACC:OFF-03] loads nothing and opens no database while every surface is off", async () => {
    const loadHost = jest.fn()
    await expect(pruneRouterFusionData(undefined, loadHost)).resolves.toBeNull()
    await expect(
      pruneRouterFusionData(
        { routerFusion: { enabled: true, surfaces: { chat: false } } },
        loadHost
      )
    ).resolves.toBeNull()
    // With the master switch off every surface is off, the companion's
    // included, and a key the build does not declare is never a surface.
    await expect(
      pruneRouterFusionData(
        { routerFusion: { enabled: false, surfaces: { companion: true } } },
        loadHost
      )
    ).resolves.toBeNull()
    await expect(
      pruneRouterFusionData(
        { routerFusion: { enabled: true, surfaces: { notASurface: true } } } as never,
        loadHost
      )
    ).resolves.toBeNull()
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("prunes the current fusion database", async () => {
    const { host, db, pruneFusionDatabase } = fakeHost()
    await expect(
      pruneRouterFusionData(
        on,
        async () => host,
        () => 42
      )
    ).resolves.toBe(report)
    expect(pruneFusionDatabase).toHaveBeenCalledWith(db, 42)
  })

  it("[ACC:ISO-01] logs a failed sweep without feeding the breaker", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await expect(
      pruneRouterFusionData(on, async () => {
        throw new RouterFusionInfrastructureError("db_unavailable", "blocked")
      })
    ).resolves.toBeNull()
    expect(getBreakerSnapshot("chat").lastFault).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("sweeps at start and on every tick, re-reading the settings, until stopped", async () => {
    const { host, pruneFusionDatabase } = fakeHost()
    let tick: (() => void) | null = null
    const clearInterval = jest.fn()
    let settings: typeof on | undefined = on
    const stop = startRouterFusionRetention(() => settings, {
      loadHost: async () => host,
      setInterval: (callback, ms) => {
        expect(ms).toBe(ROUTER_FUSION_RETENTION_INTERVAL_MS)
        tick = callback
        return "handle"
      },
      clearInterval,
    })
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(pruneFusionDatabase).toHaveBeenCalledTimes(1)

    settings = undefined
    tick!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(pruneFusionDatabase).toHaveBeenCalledTimes(1)

    settings = on
    stop()
    tick!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(pruneFusionDatabase).toHaveBeenCalledTimes(1)
    expect(clearInterval).toHaveBeenCalledWith("handle")
  })

  it("reads its settings asynchronously on a host that keeps them in the database", async () => {
    // A headless brain reads the account row each tick instead of a loaded store.
    const { host, pruneFusionDatabase } = fakeHost()
    const stop = startRouterFusionRetention(async () => on, {
      loadHost: async () => host,
      setInterval: () => "handle",
      clearInterval: () => {},
    })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(pruneFusionDatabase).toHaveBeenCalledTimes(1)
    stop()
  })

  it("skips a tick whose settings cannot be read, and keeps the schedule", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const { host, pruneFusionDatabase } = fakeHost()
    let tick: (() => void) | null = null
    let fail = true
    const stop = startRouterFusionRetention(
      async () => {
        if (fail) throw new Error("database closed")
        return on
      },
      {
        loadHost: async () => host,
        setInterval: (callback) => {
          tick = callback
          return "handle"
        },
        clearInterval: () => {},
      }
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(pruneFusionDatabase).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()

    fail = false
    tick!()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(pruneFusionDatabase).toHaveBeenCalledTimes(1)
    stop()
    warn.mockRestore()
  })

  it("skips a tick while the previous sweep is still running", async () => {
    let finish: (() => void) | null = null
    const pruneFusionDatabase = jest.fn(
      () => new Promise((resolve) => (finish = () => resolve(report)))
    )
    const host = {
      pruneFusionDatabase,
      currentFusionStore: jest.fn().mockResolvedValue({ db: {} }),
    } as unknown as RouterFusionHost
    let tick: (() => void) | null = null
    const stop = startRouterFusionRetention(() => on, {
      loadHost: async () => host,
      setInterval: (callback) => {
        tick = callback
        return 1
      },
      clearInterval: () => {},
    })
    await new Promise((resolve) => setImmediate(resolve))
    tick!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(pruneFusionDatabase).toHaveBeenCalledTimes(1)
    finish!()
    await new Promise((resolve) => setImmediate(resolve))
    tick!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(pruneFusionDatabase).toHaveBeenCalledTimes(2)
    stop()
  })
})
