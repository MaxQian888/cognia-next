import "fake-indexeddb/auto"

import {
  encodeHlc,
  fromBase64Url,
  importEcdsaPublicKey,
  verifyOpSignature,
} from "@cognia/sync-protocol"

import { TEST_SPACE } from "../enrollment/test-support"
import { __clearAccountSyncKeyCache } from "../vault-store"
import { closeAll, sealedOp, settleAll, syncedDevices, verifiedKeys } from "./test-support"

beforeEach(() => __clearAccountSyncKeyCache())

describe("account sync data test support", () => {
  it("enrolls every named device into one space, each with its own armed database", async () => {
    const { server, devices } = await syncedDevices(["a", "b", "c"])
    expect(devices.map((device) => device.name)).toEqual(["a", "b", "c"])
    const ids = await Promise.all(devices.map(async (device) => (await device.keys()).deviceId))
    for (const id of ids) expect(server.state()!.devices[id]?.status).toBe("active")
    expect(new Set(devices.map((device) => device.db.name)).size).toBe(3)
    for (const [index, device] of devices.entries())
      expect(await device.db.accountSyncState.get("capture")).toMatchObject({
        deviceId: ids[index],
      })
    closeAll(devices)
  })

  it("settles once nothing moves, and seals ops the device's key verifies", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices
    await a!.db.sessions.put({ id: "s1", title: "T", createdAt: 1, updatedAt: 1 } as never)
    await settleAll(devices)
    expect(await b!.db.sessions.get("s1")).toMatchObject({ title: "T" })

    const { keys, registry } = await verifiedKeys(a!)
    const at = encodeHlc({ ms: 1, c: 0, deviceId: keys.deviceId })
    const op = await sealedOp(a!, { t: "sessions", id: "s2", k: "delete", at }, { deviceSeq: 9 })
    expect(op.deviceSeq).toBe(9)
    const key = await importEcdsaPublicKey(
      fromBase64Url(registry.state.devices[op.deviceId]!.signPub)
    )
    expect(await verifyOpSignature(key, TEST_SPACE, op)).toBe(true)
    closeAll(devices)
  })
})
