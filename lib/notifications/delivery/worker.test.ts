/**
 * Tests for lib/notifications/delivery/worker.ts — the runtime reconcile loop
 * installed into the connector runtime. Covers the immediate first sweep, the
 * periodic re-sweep, the no-concurrent-tick guard, graceful per-lane error
 * handling (a reconcile failure doesn't kill the webhook lane), and the
 * idempotent stop.
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { startNotificationDeliveryWorker } from "./worker"
import { resolvePreferences } from "../preferences"
import type { EmitCenterRecord } from "./coordinator"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => await dbFixture.restore())
afterAll(async () => await dbFixture.dispose())

const prefs = resolvePreferences()

function deps(over: Partial<Parameters<typeof startNotificationDeliveryWorker>[0]> = {}) {
  const logs: { level: string; message: string }[] = []
  return {
    deps: {
      scopeKey: "scope-A",
      leaseOwner: "host-1",
      loadPrefs: () => prefs,
      sendHttp: async () => ({ status: 200, body: "{}" }) as never,
      resolveSecret: async () => null,
      emitCenter: (async () => undefined) as EmitCenterRecord,
      sweepMs: 1_000,
      log: (level: string, message: string) => logs.push({ level, message }),
      ...over,
    },
    logs,
  }
}

/** Flush the microtask queue so a fire-and-forget tick settles. */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  // Give the async DB + tick work a real macrotask too.
  await new Promise((r) => setTimeout(r, 0))
}

describe("startNotificationDeliveryWorker", () => {
  it("runs an immediate first sweep then stops cleanly", async () => {
    const { deps: d, logs } = deps()
    const stop = startNotificationDeliveryWorker(d)
    await settle()
    stop()
    // A clean sweep over an empty DB logs nothing and throws nothing.
    expect(logs.filter((l) => l.level === "error")).toHaveLength(0)
    stop() // idempotent — second call is a no-op
  })

  it("re-sweeps on the interval", async () => {
    let ticks = 0
    const { deps: d } = deps({
      loadPrefs: () => {
        ticks += 1
        return prefs
      },
      sweepMs: 5, // real timers — the loop re-schedules after each tick
    })
    const stop = startNotificationDeliveryWorker(d)
    await new Promise((r) => setTimeout(r, 40))
    stop()
    expect(ticks).toBeGreaterThanOrEqual(2) // immediate + at least one re-sweep
  })

  it("survives a loadPrefs failure without throwing", async () => {
    const { deps: d, logs } = deps({
      loadPrefs: () => {
        throw new Error("prefs gone")
      },
    })
    const stop = startNotificationDeliveryWorker(d)
    await settle()
    stop()
    expect(logs.some((l) => l.level === "warn" && l.message.includes("tick failed"))).toBe(true)
  })

  it("does not run two ticks concurrently", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { deps: d } = deps({
      loadPrefs: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight -= 1
        return prefs
      },
      sweepMs: 1,
    })
    const stop = startNotificationDeliveryWorker(d)
    await new Promise((r) => setTimeout(r, 40))
    stop()
    expect(maxInFlight).toBe(1)
  })
})
