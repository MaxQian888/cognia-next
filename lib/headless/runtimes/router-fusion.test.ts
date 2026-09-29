/** @jest-environment node */
import type { HeadlessRuntimeContext } from "../types"

const recoverRouterFusionRuns = jest.fn()
const stopRetention = jest.fn()
const startRouterFusionRetention = jest.fn()
jest.mock("@/lib/router-fusion/gate/boot", () => ({
  recoverRouterFusionRuns: (...args: unknown[]) => recoverRouterFusionRuns(...args),
  startRouterFusionRetention: (...args: unknown[]) => startRouterFusionRetention(...args),
}))

const getSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))

interface Observer {
  next: (value: unknown) => void
  error: (error: unknown) => void
}
const liveQueries: Array<{ query: () => Promise<unknown>; observer: Observer | null }> = []
const unsubscribe = jest.fn()
jest.mock("dexie", () => ({
  liveQuery: (query: () => Promise<unknown>) => {
    const entry: { query: () => Promise<unknown>; observer: Observer | null } = {
      query,
      observer: null,
    }
    liveQueries.push(entry)
    return {
      subscribe: (observer: Observer) => {
        entry.observer = observer
        return { unsubscribe }
      },
    }
  },
}))

const ON = { routerFusion: { enabled: true, surfaces: { gatewayRuns: true } } }
const BOTH = {
  routerFusion: { enabled: true, surfaces: { gatewayRuns: true, gatewayPassthroughLedger: true } },
}
const MASTER_OFF = {
  routerFusion: { enabled: false, surfaces: { gatewayRuns: true, gatewayPassthroughLedger: true } },
}

function makeContext(): HeadlessRuntimeContext & { log: jest.Mock; invoke: jest.Mock } {
  const invoke = jest.fn().mockResolvedValue(null)
  return {
    host: "brain",
    localAccountId: "acct-1",
    bridge: {
      listen: async () => () => undefined,
      invoke,
      respondMedia: async () => {},
    },
    invoke,
    notifyDbWrite: jest.fn(),
    resolveMessage: (key) => key,
    log: jest.fn(),
  }
}

async function loadFresh() {
  jest.resetModules()
  const { __resetHeadlessRuntimesForTesting } = await import("../registry")
  __resetHeadlessRuntimesForTesting()
  await import("./router-fusion")
  const { bootstrapHeadlessRuntimes } = await import("../bootstrap")
  return bootstrapHeadlessRuntimes
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function publishes(ctx: { invoke: jest.Mock }) {
  return ctx.invoke.mock.calls.filter(([name]) => name === "gateway_router_fusion_switches_publish")
}

beforeEach(() => {
  recoverRouterFusionRuns.mockReset().mockResolvedValue(0)
  startRouterFusionRetention.mockReset().mockReturnValue(stopRetention)
  stopRetention.mockReset()
  unsubscribe.mockReset()
  liveQueries.length = 0
  getSettings.mockReset().mockResolvedValue(ON)
})

it("sweeps and schedules retention from the account's stored settings", async () => {
  const bootstrap = await loadFresh()
  const result = await bootstrap(makeContext())
  expect(result.failed).toEqual([])
  expect(result.started).toContain("router-fusion")

  // The brain never loads the settings store, so both jobs read the row.
  await flush()
  expect(recoverRouterFusionRuns).toHaveBeenCalledWith(ON)
  const readSettings = startRouterFusionRetention.mock.calls[0][0] as () => Promise<unknown>
  await expect(readSettings()).resolves.toBe(ON)

  await result.stop()
  expect(stopRetention).toHaveBeenCalled()
})

it("keeps booting when the settings row cannot be read, treating every surface as off", async () => {
  getSettings.mockRejectedValue(new Error("database closed"))
  const bootstrap = await loadFresh()
  const ctx = makeContext()
  const result = await bootstrap(ctx)
  expect(result.failed).toEqual([])

  await flush()
  // `null` is what the gate reads as off: nothing is loaded or swept.
  expect(recoverRouterFusionRuns).toHaveBeenCalledWith(null)
  expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("could not read settings"))
  await result.stop()
})

it("does not let a failed recovery sweep fail the boot", async () => {
  recoverRouterFusionRuns.mockRejectedValue(new Error("boom"))
  const bootstrap = await loadFresh()
  const ctx = makeContext()
  const result = await bootstrap(ctx)
  expect(result.failed).toEqual([])
  await flush()
  expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("recovery failed"))
  await result.stop()
})

describe("gateway switches", () => {
  it("publishes the account's two gateway switches, and again whenever they change", async () => {
    const bootstrap = await loadFresh()
    const ctx = makeContext()
    const result = await bootstrap(ctx)
    expect(liveQueries).toHaveLength(1)
    // The watch reads the same settings row the gate falls back to.
    await expect(liveQueries[0].query()).resolves.toBe(ON)

    const observer = liveQueries[0].observer!
    observer.next(ON)
    await flush()
    expect(publishes(ctx)).toEqual([
      [
        "gateway_router_fusion_switches_publish",
        { runsEnabled: true, passthroughLedgerEnabled: false },
      ],
    ])

    // An unrelated settings write re-runs the query with the same switches:
    // nothing new is published.
    observer.next(ON)
    await flush()
    expect(publishes(ctx)).toHaveLength(1)

    observer.next(BOTH)
    observer.next(MASTER_OFF)
    await flush()
    expect(publishes(ctx).map(([, switches]) => switches)).toEqual([
      { runsEnabled: true, passthroughLedgerEnabled: false },
      { runsEnabled: true, passthroughLedgerEnabled: true },
      // The master switch off turns both off, whatever the surfaces say.
      { runsEnabled: false, passthroughLedgerEnabled: false },
    ])

    await result.stop()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("reads an unreadable settings row as both off rather than leaving the last answer", async () => {
    const bootstrap = await loadFresh()
    const ctx = makeContext()
    const result = await bootstrap(ctx)
    const observer = liveQueries[0].observer!
    observer.next(BOTH)
    observer.next(null)
    await flush()
    expect(publishes(ctx).map(([, switches]) => switches)).toEqual([
      { runsEnabled: true, passthroughLedgerEnabled: true },
      { runsEnabled: false, passthroughLedgerEnabled: false },
    ])
    await result.stop()
  })

  it("republishes on a heartbeat, so a publish dropped during a reconnect heals", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] })
    try {
      const bootstrap = await loadFresh()
      const { GATEWAY_SWITCHES_HEARTBEAT_MS } = await import("./router-fusion")
      const ctx = makeContext()
      const result = await bootstrap(ctx)
      liveQueries[0].observer!.next(BOTH)
      await flush()
      expect(publishes(ctx)).toHaveLength(1)

      jest.advanceTimersByTime(GATEWAY_SWITCHES_HEARTBEAT_MS)
      await flush()
      expect(publishes(ctx)).toHaveLength(2)
      expect(publishes(ctx)[1][1]).toEqual({ runsEnabled: true, passthroughLedgerEnabled: true })

      await result.stop()
      jest.advanceTimersByTime(GATEWAY_SWITCHES_HEARTBEAT_MS * 3)
      await flush()
      expect(publishes(ctx)).toHaveLength(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it("logs a publish the bridge refused without failing the runtime", async () => {
    const bootstrap = await loadFresh()
    const ctx = makeContext()
    ctx.invoke.mockRejectedValue(new Error("not connected"))
    const result = await bootstrap(ctx)
    liveQueries[0].observer!.next(ON)
    await flush()
    await flush()
    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("could not publish gateway switches")
    )
    await result.stop()
  })

  it("answers exactly what the desktop's routing snapshot says for the same settings", async () => {
    jest.resetModules()
    // The desktop publisher imports the whole database layer; give it the real Dexie.
    jest.doMock("dexie", () => jest.requireActual("dexie"))
    const { gatewaySwitchesOf } = await import("./router-fusion")
    const { routerFusionSwitchesOf } = await import("@/lib/gateway/snapshot-publisher")
    for (const settings of [ON, BOTH, MASTER_OFF, {}, { routerFusion: null }]) {
      expect(gatewaySwitchesOf(settings as never)).toEqual(
        routerFusionSwitchesOf((settings as { routerFusion?: never }).routerFusion)
      )
    }
  })
})
