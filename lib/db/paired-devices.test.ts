import "fake-indexeddb/auto"

import {
  addPairedDevice,
  getPairedDevice,
  listPairedDevices,
  revokePairedDevice,
  setPushToken,
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
      nowMs: 1_700_000_000_000,
    })
    const row = await getPairedDevice("dev-1")
    expect(row).toBeDefined()
    expect(row?.deviceId).toBe("dev-1")
    expect(row?.label).toBe("iPhone 15")
    expect(row?.platform).toBe("ios")
    expect(row?.pubkey).toBe("spki-base64")
    expect(row?.appVersion).toBe("0.1.0")
    expect(row?.pairedAt).toBe(1_700_000_000_000)
    expect(row?.lastSeenAt).toBe(1_700_000_000_000)
    expect(row?.revokedAt).toBeUndefined()
    expect(row?.pushToken).toBeUndefined()
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
