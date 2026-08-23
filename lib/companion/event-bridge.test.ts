/** @jest-environment jsdom */
/**
 * Coverage for the Rust → Dexie event bridge.
 *
 * Spies on `transport.subscribe` to capture the handlers registered by
 * `installCompanionEventBridge`, then drives them with synthetic payloads and
 * asserts the Dexie helpers receive the right shapes. Uses fake-indexeddb so
 * the writes actually round-trip.
 */

import "fake-indexeddb/auto"
import { waitFor } from "@testing-library/react"
import { installCompanionEventBridge } from "./event-bridge"
import { transport } from "@/lib/tauri"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listPairedDevices } from "@/lib/db/paired-devices"
import {
  attachedDeviceIds,
  __resetRemoteAttachForTests,
} from "@/lib/companion/remote-attach-registry"
import { attachSessionLease, syncEventStreams } from "@/lib/companion/device-presence-registry"
import { useAccountStore } from "@/stores/account/account-store"

/** Give `deviceId` a live stream and a control attachment on `sessionId`. */
function attachSessionForTest(sessionId: string, deviceId: string): void {
  const at = Date.now()
  syncEventStreams({
    deviceId,
    streams: [{ leaseId: `esl-${deviceId}`, transport: "ws", state: "ready", openedAt: at }],
    at,
  })
  attachSessionLease({
    sessionId,
    deviceId,
    mode: "control",
    eventStreamLeaseId: `esl-${deviceId}`,
    at,
  })
}

jest.mock("@/stores/account/account-store", () => {
  const mockAccountStoreState = {
    unlockedAccountId: "local_acct_a" as string | null,
  }
  return {
    useAccountStore: {
      getState: () => mockAccountStoreState,
    },
  }
})

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
  ;(useAccountStore.getState() as { unlockedAccountId: string | null }).unlockedAccountId =
    "local_acct_a"
  // Process-global presence maps — reset so leases never leak between cases.
  __resetRemoteAttachForTests()
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
  it("subscribes to every companion event channel", () => {
    const { spy } = captureHandlers()
    installCompanionEventBridge()
    expect(spy).toHaveBeenCalledWith("companion://device-paired", expect.any(Function))
    expect(spy).toHaveBeenCalledWith("companion://device-seen", expect.any(Function))
    expect(spy).toHaveBeenCalledWith("companion://device-lifecycle", expect.any(Function))
    expect(spy).toHaveBeenCalledTimes(3)
  })

  /**
   * Attach leases are renderer-owned, so nothing but this handler can release
   * them when a pairing is suspended or revoked. Without it the device kept its
   * control lease for the full TTL and went on being handed approval prompts it
   * had just lost the right to answer.
   */
  it("device-lifecycle drops the device's attachments on suspend and revoke", () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const handler = handlers.get("companion://device-lifecycle")!

    attachSessionForTest("s-1", "dev-A")
    handler({ deviceId: "dev-A", action: "restore", state: "active" })
    expect(attachedDeviceIds("s-1")).toEqual(["dev-A"])

    handler({ deviceId: "dev-A", action: "revoke", state: "revoked" })
    expect(attachedDeviceIds("s-1")).toEqual([])
  })

  /**
   * The bytes exist only so a message from that device can carry them, and a
   * suspended device may no longer send one. Waiting for the 30-minute
   * collector would leave a revoked phone's screenshot on the desktop's disk.
   */
  it("device-lifecycle drops the device's staged attachments too", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const handler = handlers.get("companion://device-lifecycle")!

    const store = await import("@/lib/db/session-attachment-uploads")
    const { sha256Bytes } = await import("@/lib/ocr/hash")
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const open = async (deviceId: string) =>
      store.beginAttachmentUpload({
        sessionId: "s-1",
        deviceId,
        name: "shot.png",
        mediaType: "image/png",
        size: png.byteLength,
        hash: await sha256Bytes(png),
      })
    const mine = await open("dev-A")
    const theirs = await open("dev-B")

    handler({ deviceId: "dev-A", action: "revoke", state: "revoked" })

    const rows = () => getDb().sessionAttachmentUploads
    await waitFor(async () => {
      expect(await rows().get(mine.uploadId)).toBeUndefined()
    })
    // Nobody else's staging area is touched by one device's revocation.
    expect(await rows().get(theirs.uploadId)).toBeDefined()
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
      account_id: "local_acct_a",
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
      accountId: "local_acct_a",
      appVersion: "0.1.0",
      pairedAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_000,
    })
  })

  it("device-paired handler rejects a payload for another local account", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const handler = handlers.get("companion://device-paired")!
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

    handler({
      device_id: "dev-wrong-account",
      label: "Other account phone",
      platform: "ios",
      pubkey: "k",
      paired_at_ms: 1_700_000_000_000,
      app_version: "0.1.0",
      account_id: "local_acct_b",
    })
    await flushMicrotasks()

    await expect(listPairedDevices()).resolves.toEqual([])
    warnSpy.mockRestore()
  })

  it("device-paired handler adopts a pre-unlock pairing into the active account", async () => {
    // A device can pair before anyone has unlocked, so the Host stamps the
    // `__local__` sentinel until a verified unlock binds it to an account. The
    // renderer adopts that bucket rather than dropping the row — the same rule
    // the credential book already applies to unclaimed pairings.
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const handler = handlers.get("companion://device-paired")!

    handler({
      device_id: "dev-pre-unlock",
      label: "Pre-unlock phone",
      platform: "ios",
      pubkey: "k",
      paired_at_ms: 1_700_000_000_000,
      app_version: "0.1.0",
      account_id: "__local__",
    })
    await flushMicrotasks()

    const rows = await listPairedDevices()
    expect(rows.map((row) => row.deviceId)).toEqual(["dev-pre-unlock"])
  })

  it("device-seen handler adopts a pre-unlock sighting into the active account", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const pairedHandler = handlers.get("companion://device-paired")!
    const seenHandler = handlers.get("companion://device-seen")!

    pairedHandler({
      device_id: "dev-adopted",
      label: "Phone",
      platform: "android",
      pubkey: "k",
      paired_at_ms: 100,
      app_version: "0.1.0",
      account_id: "local_acct_a",
    })
    await flushMicrotasks()

    seenHandler({ device_id: "dev-adopted", seen_at_ms: 900, account_id: "__local__" })
    await flushMicrotasks()

    const rows = await listPairedDevices()
    expect(rows[0]?.lastSeenAt).toBe(900)
  })

  it("device-paired handler rejects missing and locked local account payloads", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const handler = handlers.get("companion://device-paired")!
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

    handler({
      device_id: "dev-missing-account",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      paired_at_ms: 1_700_000_000_000,
      app_version: "0.1.0",
    })
    await flushMicrotasks()
    await expect(listPairedDevices()).resolves.toEqual([])
    ;(useAccountStore.getState() as { unlockedAccountId: string | null }).unlockedAccountId = null
    handler({
      device_id: "dev-locked-account",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      paired_at_ms: 1_700_000_000_000,
      app_version: "0.1.0",
      account_id: "local_acct_a",
    })
    await flushMicrotasks()
    await expect(listPairedDevices()).resolves.toEqual([])
    warnSpy.mockRestore()
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
      account_id: "local_acct_a",
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
      account_id: "local_acct_a",
    })
    await flushMicrotasks()

    seenHandler({
      device_id: "dev-C",
      seen_at_ms: 1_700_000_500_000,
      account_id: "local_acct_a",
    })
    await flushMicrotasks()

    const rows = await listPairedDevices()
    expect(rows[0]?.lastSeenAt).toBe(1_700_000_500_000)
    expect(rows[0]?.pairedAt).toBe(1_700_000_000_000)
  })

  it("device-seen handler rejects a payload for another local account", async () => {
    const { handlers } = captureHandlers()
    installCompanionEventBridge()
    const pairedHandler = handlers.get("companion://device-paired")!
    const seenHandler = handlers.get("companion://device-seen")!
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

    pairedHandler({
      device_id: "dev-D",
      label: "Phone",
      platform: "android",
      pubkey: "k",
      paired_at_ms: 100,
      app_version: "0.1.0",
      account_id: "local_acct_a",
    })
    await flushMicrotasks()

    seenHandler({
      device_id: "dev-D",
      seen_at_ms: 500,
      account_id: "local_acct_b",
    })
    await flushMicrotasks()

    const rows = await listPairedDevices()
    expect(rows[0]?.lastSeenAt).toBe(100)
    warnSpy.mockRestore()
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
        account_id: "local_acct_a",
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
