/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import {
  addPairedDevice,
  getPairedDevice,
  listPairedDevices,
  pausePairedDevice,
  recordDeviceCapabilities,
  resumePairedDevice,
  revokePairedDevice,
  setServerFingerprint,
  setPushToken,
  setAgentControlAllowed,
  setRemoteControlAllowed,
  touchPairedDevice,
} from "./paired-devices"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("addPairedDevice", () => {
  it("inserts a row with both pairedAt and lastSeenAt set to nowMs", async () => {
    await addPairedDevice({
      deviceId: "dev-1",
      label: "iPhone 15",
      platform: "ios",
      pubkey: "spki-base64",
      appVersion: "0.1.0",
      accountId: "local_acct_a",
      nowMs: 1_700_000_000_000,
    })
    const row = await getPairedDevice("dev-1")
    expect(row).toBeDefined()
    expect(row?.deviceId).toBe("dev-1")
    expect(row?.label).toBe("iPhone 15")
    expect(row?.platform).toBe("ios")
    expect(row?.pubkey).toBe("spki-base64")
    expect(row?.accountId).toBe("local_acct_a")
    expect(row?.appVersion).toBe("0.1.0")
    expect(row?.pairedAt).toBe(1_700_000_000_000)
    expect(row?.lastSeenAt).toBe(1_700_000_000_000)
    expect(row?.revokedAt).toBeUndefined()
    expect(row?.pushToken).toBeUndefined()
  })

  it("keeps accountId absent for legacy callers that do not provide it", async () => {
    await addPairedDevice({
      deviceId: "dev-legacy",
      label: "Legacy Phone",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })

    const row = await getPairedDevice("dev-legacy")
    expect(row?.accountId).toBeUndefined()
  })

  it("defaults nowMs to Date.now() when omitted", async () => {
    const before = Date.now()
    await addPairedDevice({
      deviceId: "dev-2",
      label: "Pixel 9",
      platform: "android",
      pubkey: "pk",
      appVersion: "0.1.0",
    })
    const after = Date.now()
    const row = await getPairedDevice("dev-2")
    expect(row?.pairedAt).toBeGreaterThanOrEqual(before)
    expect(row?.pairedAt).toBeLessThanOrEqual(after)
    expect(row?.pairedAt).toBe(row?.lastSeenAt)
  })

  it("overwrites an existing row when called twice with the same deviceId (re-pair)", async () => {
    await addPairedDevice({
      deviceId: "dev-3",
      label: "old",
      platform: "ios",
      pubkey: "pk1",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    await addPairedDevice({
      deviceId: "dev-3",
      label: "new",
      platform: "ios",
      pubkey: "pk2",
      appVersion: "0.2.0",
      nowMs: 2,
    })
    const row = await getPairedDevice("dev-3")
    expect(row?.label).toBe("new")
    expect(row?.pubkey).toBe("pk2")
    expect(row?.pairedAt).toBe(2)
  })

  it("persists optional TLS and WebRTC pairing metadata", async () => {
    await addPairedDevice({
      deviceId: "dev-meta",
      label: "Phone",
      platform: "android",
      pubkey: "pk",
      appVersion: "0.1.0",
      serverFingerprint: "sha256:abc",
      rendezvousId: "room-1",
      rendezvousSecret: "secret-1",
      nowMs: 10,
    })

    const row = await getPairedDevice("dev-meta")
    expect(row).toEqual(
      expect.objectContaining({
        serverFingerprint: "sha256:abc",
        rendezvousId: "room-1",
        rendezvousSecret: "secret-1",
      })
    )
  })
})

describe("setServerFingerprint", () => {
  it("updates an existing device fingerprint and returns true", async () => {
    await addPairedDevice({
      deviceId: "dev-fp",
      label: "Phone",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })

    await expect(setServerFingerprint("dev-fp", "sha256:new")).resolves.toBe(true)
    await expect(getPairedDevice("dev-fp")).resolves.toEqual(
      expect.objectContaining({ serverFingerprint: "sha256:new" })
    )
  })

  it("returns false for an unknown device fingerprint update", async () => {
    await expect(setServerFingerprint("missing", "sha256:new")).resolves.toBe(false)
  })
})

describe("revokePairedDevice", () => {
  it("stamps revokedAt and returns true when the row exists", async () => {
    await addPairedDevice({
      deviceId: "dev-r1",
      label: "phone",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const ok = await revokePairedDevice("dev-r1", 999)
    expect(ok).toBe(true)
    const row = await getPairedDevice("dev-r1")
    expect(row?.revokedAt).toBe(999)
  })

  it("returns false for an unknown deviceId", async () => {
    const ok = await revokePairedDevice("does-not-exist", 999)
    expect(ok).toBe(false)
  })

  it("defaults nowMs to Date.now()", async () => {
    await addPairedDevice({
      deviceId: "dev-r2",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const before = Date.now()
    await revokePairedDevice("dev-r2")
    const after = Date.now()
    const row = await getPairedDevice("dev-r2")
    expect(row?.revokedAt).toBeGreaterThanOrEqual(before)
    expect(row?.revokedAt).toBeLessThanOrEqual(after)
  })
})

describe("pausePairedDevice", () => {
  it("stamps pausedAt without setting revokedAt", async () => {
    await addPairedDevice({
      deviceId: "dev-p1",
      label: "phone",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const ok = await pausePairedDevice("dev-p1", 555)
    expect(ok).toBe(true)
    const row = await getPairedDevice("dev-p1")
    expect(row?.pausedAt).toBe(555)
    expect(row?.revokedAt).toBeUndefined()
  })

  it("returns false for an unknown deviceId", async () => {
    expect(await pausePairedDevice("missing", 1)).toBe(false)
  })

  it("defaults nowMs to Date.now()", async () => {
    await addPairedDevice({
      deviceId: "dev-p2",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const before = Date.now()
    await pausePairedDevice("dev-p2")
    const after = Date.now()
    const row = await getPairedDevice("dev-p2")
    expect(row?.pausedAt).toBeGreaterThanOrEqual(before)
    expect(row?.pausedAt).toBeLessThanOrEqual(after)
  })
})

describe("resumePairedDevice", () => {
  it("clears pausedAt and returns true when the device was paused", async () => {
    await addPairedDevice({
      deviceId: "dev-r1",
      label: "phone",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    await pausePairedDevice("dev-r1", 999)
    expect((await getPairedDevice("dev-r1"))?.pausedAt).toBe(999)
    const ok = await resumePairedDevice("dev-r1")
    expect(ok).toBe(true)
    const row = await getPairedDevice("dev-r1")
    expect(row?.pausedAt).toBeUndefined()
  })

  it("returns false for an unknown deviceId", async () => {
    expect(await resumePairedDevice("never-paused")).toBe(false)
  })

  it("is idempotent — resuming an already-active device does nothing harmful", async () => {
    await addPairedDevice({
      deviceId: "dev-r2",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const ok = await resumePairedDevice("dev-r2")
    expect(ok).toBe(true) // the row was matched even though there was nothing to clear
    const row = await getPairedDevice("dev-r2")
    expect(row?.pausedAt).toBeUndefined()
    expect(row?.revokedAt).toBeUndefined()
  })

  it("leaves an existing revokedAt untouched", async () => {
    await addPairedDevice({
      deviceId: "dev-r3",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    await revokePairedDevice("dev-r3", 100)
    await pausePairedDevice("dev-r3", 200)
    await resumePairedDevice("dev-r3")
    const row = await getPairedDevice("dev-r3")
    expect(row?.revokedAt).toBe(100)
    expect(row?.pausedAt).toBeUndefined()
  })
})

describe("touchPairedDevice", () => {
  it("updates lastSeenAt without touching pairedAt", async () => {
    await addPairedDevice({
      deviceId: "dev-t1",
      label: "phone",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 100,
    })
    await touchPairedDevice("dev-t1", 500)
    const row = await getPairedDevice("dev-t1")
    expect(row?.pairedAt).toBe(100)
    expect(row?.lastSeenAt).toBe(500)
  })

  it("silently absorbs a missing row (best-effort contract)", async () => {
    await expect(touchPairedDevice("does-not-exist", 1)).resolves.toBeUndefined()
  })

  it("silently absorbs a Dexie error (db deleted under us)", async () => {
    await getDb().delete()
    // After delete + before reset, calling .update throws DatabaseClosedError.
    await expect(touchPairedDevice("dev-x", 1)).resolves.toBeUndefined()
  })

  it("defaults nowMs to Date.now()", async () => {
    await addPairedDevice({
      deviceId: "dev-t2",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const before = Date.now()
    await touchPairedDevice("dev-t2")
    const after = Date.now()
    const row = await getPairedDevice("dev-t2")
    expect(row?.lastSeenAt).toBeGreaterThanOrEqual(before)
    expect(row?.lastSeenAt).toBeLessThanOrEqual(after)
  })
})

describe("listPairedDevices", () => {
  it("returns rows sorted by lastSeenAt newest-first", async () => {
    await addPairedDevice({
      deviceId: "old",
      label: "a",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 100,
    })
    await addPairedDevice({
      deviceId: "newest",
      label: "b",
      platform: "android",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 300,
    })
    await addPairedDevice({
      deviceId: "middle",
      label: "c",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 200,
    })
    const list = await listPairedDevices()
    expect(list.map((r) => r.deviceId)).toEqual(["newest", "middle", "old"])
  })

  it("includes revoked rows so the UI can render tombstones", async () => {
    await addPairedDevice({
      deviceId: "revoked",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    await revokePairedDevice("revoked", 999)
    const list = await listPairedDevices()
    expect(list).toHaveLength(1)
    expect(list[0].revokedAt).toBe(999)
  })

  it("returns an empty array when no devices have been paired", async () => {
    await expect(listPairedDevices()).resolves.toEqual([])
  })
})

describe("getPairedDevice", () => {
  it("returns undefined when the deviceId is unknown", async () => {
    await expect(getPairedDevice("nope")).resolves.toBeUndefined()
  })
})

describe("setPushToken", () => {
  it("stores a token and returns true", async () => {
    await addPairedDevice({
      deviceId: "dev-p1",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const ok = await setPushToken("dev-p1", "apns-token-abc")
    expect(ok).toBe(true)
    const row = await getPairedDevice("dev-p1")
    expect(row?.pushToken).toBe("apns-token-abc")
  })

  it("clears the token when passed undefined", async () => {
    await addPairedDevice({
      deviceId: "dev-p2",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    await setPushToken("dev-p2", "tok")
    await setPushToken("dev-p2", undefined)
    const row = await getPairedDevice("dev-p2")
    expect(row?.pushToken).toBeUndefined()
  })

  it("returns false for an unknown deviceId", async () => {
    const ok = await setPushToken("does-not-exist", "tok")
    expect(ok).toBe(false)
  })
})

describe("setRemoteControlAllowed", () => {
  it("defaults to undefined for a freshly-paired device (deny by default)", async () => {
    await addPairedDevice({
      deviceId: "dev-rc1",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const row = await getPairedDevice("dev-rc1")
    expect(row?.allowRemoteControl).toBeUndefined()
  })

  it("grants the capability and returns true", async () => {
    await addPairedDevice({
      deviceId: "dev-rc2",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const ok = await setRemoteControlAllowed("dev-rc2", true)
    expect(ok).toBe(true)
    const row = await getPairedDevice("dev-rc2")
    expect(row?.allowRemoteControl).toBe(true)
  })

  it("records an explicit false when revoked (not deleted)", async () => {
    await addPairedDevice({
      deviceId: "dev-rc3",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    await setRemoteControlAllowed("dev-rc3", true)
    await setRemoteControlAllowed("dev-rc3", false)
    const row = await getPairedDevice("dev-rc3")
    expect(row?.allowRemoteControl).toBe(false)
  })

  it("returns false for an unknown deviceId", async () => {
    expect(await setRemoteControlAllowed("does-not-exist", true)).toBe(false)
  })
})

describe("setAgentControlAllowed", () => {
  async function pair(deviceId: string) {
    await addPairedDevice({
      deviceId,
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
  }

  it("defaults to undefined for a freshly-paired device (deny by default)", async () => {
    await pair("dev-ac1")
    expect((await getPairedDevice("dev-ac1"))?.allowAgentControl).toBeUndefined()
  })

  it("grants the capability and returns true", async () => {
    await pair("dev-ac2")
    expect(await setAgentControlAllowed("dev-ac2", true)).toBe(true)
    expect((await getPairedDevice("dev-ac2"))?.allowAgentControl).toBe(true)
  })

  it("records an explicit false when revoked (not deleted)", async () => {
    await pair("dev-ac3")
    await setAgentControlAllowed("dev-ac3", true)
    await setAgentControlAllowed("dev-ac3", false)
    expect((await getPairedDevice("dev-ac3"))?.allowAgentControl).toBe(false)
  })

  it("returns false for an unknown deviceId", async () => {
    expect(await setAgentControlAllowed("does-not-exist", true)).toBe(false)
  })

  it("is independent of the remote-control grant in both directions", async () => {
    // The whole point of a second column: letting a phone approve prompts must
    // not also let it start processes, and vice versa.
    await pair("dev-ac4")
    await setRemoteControlAllowed("dev-ac4", true)
    expect((await getPairedDevice("dev-ac4"))?.allowAgentControl).toBeUndefined()

    await setAgentControlAllowed("dev-ac4", true)
    await setRemoteControlAllowed("dev-ac4", false)
    const row = await getPairedDevice("dev-ac4")
    expect(row?.allowRemoteControl).toBe(false)
    expect(row?.allowAgentControl).toBe(true)
  })
})

describe("recordDeviceCapabilities", () => {
  it("persists the manifest and its report timestamp", async () => {
    await addPairedDevice({
      deviceId: "dev-cap1",
      label: "x",
      platform: "ios",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    const ok = await recordDeviceCapabilities("dev-cap1", ["camera", "geolocation"], 42)
    expect(ok).toBe(true)
    const row = await getPairedDevice("dev-cap1")
    expect(row?.capabilities).toEqual(["camera", "geolocation"])
    expect(row?.capabilitiesReportedAt).toBe(42)
  })

  it("overwrites the previous manifest wholesale (snapshot, not delta)", async () => {
    await addPairedDevice({
      deviceId: "dev-cap2",
      label: "x",
      platform: "android",
      pubkey: "pk",
      appVersion: "0.1.0",
      nowMs: 1,
    })
    await recordDeviceCapabilities("dev-cap2", ["camera", "voice-record"], 1)
    await recordDeviceCapabilities("dev-cap2", ["camera"], 2)
    const row = await getPairedDevice("dev-cap2")
    expect(row?.capabilities).toEqual(["camera"])
    expect(row?.capabilitiesReportedAt).toBe(2)
  })

  it("returns false for an unknown deviceId", async () => {
    expect(await recordDeviceCapabilities("does-not-exist", ["camera"])).toBe(false)
  })
})
