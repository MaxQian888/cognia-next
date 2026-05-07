/**
 * Coverage for the Rust → Dexie event bridge.
 *
 * Spies on `transport.subscribe` to capture the handlers registered by
 * `installCompanionEventBridge`, then drives them with synthetic payloads and
 * asserts the Dexie helpers receive the right shapes. Uses fake-indexeddb so
 * the writes actually round-trip.
 */

import "fake-indexeddb/auto"
import { installCompanionEventBridge } from "./event-bridge"
import { transport } from "@/lib/tauri"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listPairedDevices } from "@/lib/db/paired-devices"

type Handler = (payload: unknown) => void

/**
 * Flush queued microtasks + a tick of the event loop. The event-bridge
 * handlers fire-and-forget Promises (`void handle...`); waiting for them
 * via `await Promise.resolve()` once isn't enough — Dexie's `.put` /
 * `.update` chains across multiple microtask ticks.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

afterEach(() => {
  jest.restoreAllMocks()
})

function captureHandlers() {
  const handlers = new Map<string, Handler>()
  const unsubs = new Map<string, jest.Mock<void, []>>()

  const spy = jest
    .spyOn(transport, "subscribe")
    .mockImplementation((event: string, handler: Handler) => {
      handlers.set(event, handler)
      const unsub = jest.fn<void, []>()
      unsubs.set(event, unsub)
      return unsub
    })

  return { handlers, unsubs, spy }
}

describe("installCompanionEventBridge", () => {
  it("subscribes to both companion event channels", () => {
    const { spy } = captureHandlers()
    installCompanionEventBridge()
    expect(spy).toHaveBeenCalledWith("companion://device-paired", expect.any(Function))
    expect(spy).toHaveBeenCalledWith("companion://device-seen", expect.any(Function))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("device-paired handler writes a row to pairedDevices", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const handler = handlers.get("companion://device-paired")!

    handler({
      device_id: "dev-A",
      label: "Max iPhone",
      platform: "ios",
      pubkey: "base64-pubkey",
      paired_at_ms: 1_700_000_000_000,
      app_version: "0.1.0",
    })

    // The handler returns a Promise via `void` — flush microtasks.
    await flushMicrotasks()

    const rows = await listPairedDevices()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      deviceId: "dev-A",
      label: "Max iPhone",
      platform: "ios",
      pubkey: "base64-pubkey",
      appVersion: "0.1.0",
      pairedAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_000,
    })
  })

  it("normalizes unknown platform strings to 'unknown'", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const handler = handlers.get("companion://device-paired")!

    handler({
      device_id: "dev-B",
      label: "Mystery",
      platform: "feature-phone",
      pubkey: "k",
      paired_at_ms: 1_700_000_000_000,
      app_version: "0.0.1",
    })
    await flushMicrotasks()

    const rows = await listPairedDevices()
    expect(rows[0]?.platform).toBe("unknown")
  })

  it("device-seen handler updates lastSeenAt for an existing row", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const pairedHandler = handlers.get("companion://device-paired")!
    const seenHandler = handlers.get("companion://device-seen")!

    pairedHandler({
      device_id: "dev-C",
      label: "Phone",
      platform: "android",
      pubkey: "k",
      paired_at_ms: 1_700_000_000_000,
      app_version: "0.1.0",
    })
    await flushMicrotasks()

    seenHandler({ device_id: "dev-C", seen_at_ms: 1_700_000_500_000 })
    await flushMicrotasks()

    const rows = await listPairedDevices()
    expect(rows[0]?.lastSeenAt).toBe(1_700_000_500_000)
    expect(rows[0]?.pairedAt).toBe(1_700_000_000_000)
  })

  it("returns an unsubscribe that detaches both handlers", () => {
    const { unsubs } = captureHandlers()
    const detach = installCompanionEventBridge()
    detach()
    const pairedUnsub = unsubs.get("companion://device-paired")!
    const seenUnsub = unsubs.get("companion://device-seen")!
    expect(pairedUnsub).toHaveBeenCalledTimes(1)
    expect(seenUnsub).toHaveBeenCalledTimes(1)
  })

  it("swallows Dexie errors so the handler never throws", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const handler = handlers.get("companion://device-paired")!

    // Force the Dexie write to fail by deleting the database mid-flight.
    await getDb().delete()
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

    expect(() =>
      handler({
        device_id: "dev-D",
        label: "Gone",
        platform: "ios",
        pubkey: "k",
        paired_at_ms: 1,
        app_version: "0.1.0",
      })
    ).not.toThrow()
    await flushMicrotasks()

    // Re-seed so afterEach cleanup works deterministically.
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    warnSpy.mockRestore()
  })
})
