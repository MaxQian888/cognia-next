/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import {
  SURFACE_SWEEP_INTERVAL_MS,
  startBindRequestExpirySweep,
  startLarkSurfaceSweep,
  sweepAllLarkSurfaces,
} from "./surface-schedule"

function adapter(overrides: Partial<AdapterInstanceRow>): AdapterInstanceRow {
  return {
    id: "lk-1",
    type: "lark",
    displayName: "Bot",
    enabled: true,
    settings: {},
    ...overrides,
  } as unknown as AdapterInstanceRow
}

/** Records timer registrations so the schedule can be driven synchronously. */
function fakeScheduler() {
  const timers: Array<{ cb: () => void; ms: number; kind: "timeout" | "interval" }> = []
  return {
    timers,
    scheduler: {
      setTimeout: (cb: () => void, ms: number) => {
        timers.push({ cb, ms, kind: "timeout" as const })
        return timers.length
      },
      clearTimeout: () => undefined,
      setInterval: (cb: () => void, ms: number) => {
        timers.push({ cb, ms, kind: "interval" as const })
        return timers.length
      },
      clearInterval: () => undefined,
    },
  }
}

describe("sweepAllLarkSurfaces", () => {
  it("sweeps every enabled lark adapter and skips the rest", async () => {
    const sweep = jest.fn(async (_ctx: { adapterId: string }) => ({
      synced: 1,
      errors: 0,
      skipped: 0,
    }))
    const totals = await sweepAllLarkSurfaces({
      listAdapters: async () => [
        adapter({ id: "lk-1" }),
        adapter({ id: "lk-off", enabled: false }),
        adapter({ id: "tg-1", type: "telegram" }),
        adapter({ id: "lk-2" }),
      ],
      keyringGet: jest.fn(async () => "secret") as never,
      sweep: sweep as never,
    })

    expect(totals).toEqual({ adapters: 2, synced: 2, errors: 0 })
    expect(sweep.mock.calls.map((call) => (call[0] as { adapterId: string }).adapterId)).toEqual([
      "lk-1",
      "lk-2",
    ])
  })

  it("resolves credentials per adapter from the keyring", async () => {
    const keyringGet = jest.fn(async (_id: string, key: string) =>
      key === "appId" ? "cli_1" : "sec_1"
    )
    let resolved: unknown
    await sweepAllLarkSurfaces({
      listAdapters: async () => [adapter({ id: "lk-1" })],
      keyringGet: keyringGet as never,
      sweep: (async (ctx: { resolveCreds: () => Promise<unknown> }) => {
        resolved = await ctx.resolveCreds()
        return { synced: 0, errors: 0, skipped: 0 }
      }) as never,
    })
    expect(resolved).toEqual({ appId: "cli_1", appSecret: "sec_1" })
  })

  it("keeps sweeping after one adapter throws", async () => {
    const sweep = jest.fn(async (ctx: { adapterId: string }) => {
      if (ctx.adapterId === "lk-bad") throw new Error("credentials expired")
      return { synced: 1, errors: 0, skipped: 0 }
    })
    const totals = await sweepAllLarkSurfaces({
      listAdapters: async () => [adapter({ id: "lk-bad" }), adapter({ id: "lk-good" })],
      keyringGet: jest.fn(async () => "s") as never,
      sweep: sweep as never,
    })
    expect(totals).toEqual({ adapters: 2, synced: 1, errors: 0 })
  })

  it("counts reconcile errors so the operator sees a stuck fleet", async () => {
    const totals = await sweepAllLarkSurfaces({
      listAdapters: async () => [adapter({ id: "lk-1" })],
      keyringGet: jest.fn(async () => "s") as never,
      sweep: (async () => ({ synced: 0, errors: 3, skipped: 1 })) as never,
    })
    expect(totals).toEqual({ adapters: 1, synced: 0, errors: 3 })
  })
})

describe("startLarkSurfaceSweep", () => {
  it("runs on an interval shorter than the 1 h backoff cap", () => {
    const { timers, scheduler } = fakeScheduler()
    const handle = startLarkSurfaceSweep({
      initialDelayMs: 0,
      scheduler,
      deps: { listAdapters: async () => [], keyringGet: (async () => null) as never },
    })

    // A capped row retries hourly; the driver must fire more often than that
    // or the cap becomes the real interval.
    expect(SURFACE_SWEEP_INTERVAL_MS).toBeLessThan(60 * 60 * 1000)
    timers[0].cb()
    const interval = timers.find((t) => t.kind === "interval")
    expect(interval?.ms).toBe(SURFACE_SWEEP_INTERVAL_MS)
    handle.dispose()
  })

  it("drives a real sweep through runNow", async () => {
    const sweep = jest.fn(async () => ({ synced: 0, errors: 0, skipped: 0 }))
    const { scheduler } = fakeScheduler()
    const handle = startLarkSurfaceSweep({
      initialDelayMs: 0,
      scheduler,
      deps: {
        listAdapters: async () => [adapter({ id: "lk-1" })],
        keyringGet: (async () => "s") as never,
        sweep: sweep as never,
      },
    })
    await handle.runNow()
    expect(sweep).toHaveBeenCalledTimes(1)
    handle.dispose()
  })
})

describe("startBindRequestExpirySweep", () => {
  it("expires stale requests on each tick", async () => {
    const sweep = jest.fn(async () => 2)
    const { scheduler } = fakeScheduler()
    const handle = startBindRequestExpirySweep({ initialDelayMs: 0, scheduler, sweep })

    await handle.runNow()

    expect(sweep).toHaveBeenCalledTimes(1)
    handle.dispose()
  })

  it("survives a failing sweep without tearing down the schedule", async () => {
    const { scheduler } = fakeScheduler()
    const handle = startBindRequestExpirySweep({
      initialDelayMs: 0,
      scheduler,
      sweep: async () => {
        throw new Error("db closed")
      },
    })
    await expect(handle.runNow()).resolves.toBeUndefined()
    handle.dispose()
  })
})
