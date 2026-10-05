import "fake-indexeddb/auto"

import { makeDevice } from "@cognia/sync-protocol/testing/chain"

import { encodeHlc, signOp } from "@cognia/sync-protocol"

import { revokeDevice } from "../enrollment/manage"
import { TEST_SPACE } from "../enrollment/test-support"
import { __clearAccountSyncKeyCache } from "../vault-store"
import { OpOriginError, createOpOriginChecker } from "./op-origin"
import { closeAll, sealedOp, syncedDevices, verifiedKeys, type SyncDevice } from "./test-support"

beforeEach(() => __clearAccountSyncKeyCache())

const upsert = (deviceId: string) => ({
  t: "sessions",
  id: "s1",
  k: "upsert" as const,
  f: { title: ["T", encodeHlc({ ms: 1_000, c: 0, deviceId })] as [unknown, string] },
})

async function errorOf(promise: Promise<unknown>): Promise<OpOriginError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(OpOriginError)
  return error as OpOriginError
}

describe("createOpOriginChecker", () => {
  it("accepts a signed op from a device of the space", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const { registry } = await verifiedKeys(a)
    const op = await sealedOp(b, upsert((await b.keys()).deviceId))
    await expect(createOpOriginChecker(registry).check(op)).resolves.toBeUndefined()
    closeAll(devices)
  })

  it("refuses a device outside the list and a signature that does not verify", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const { registry } = await verifiedKeys(a)
    const checker = createOpOriginChecker(registry)

    const op = await sealedOp(b, upsert((await b.keys()).deviceId))
    const stranger = await makeDevice()
    const { sig: _sig, ...unsigned } = op
    const foreign = await signOp(stranger.sign.privateKey, TEST_SPACE, {
      ...unsigned,
      deviceId: stranger.deviceId,
    })
    expect((await errorOf(checker.check(foreign))).message).toMatch(/not in this space/)

    const resigned = await signOp(stranger.sign.privateKey, TEST_SPACE, unsigned)
    const error = await errorOf(checker.check(resigned))
    expect(error.message).toMatch(/signature/)
    expect(error.op).toMatchObject({ deviceId: op.deviceId, deviceSeq: 1 })
    closeAll(devices)
  })

  it("accepts a removed device's ops only under epochs before its removal", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const before = (await verifiedKeys(b)).registry.state.epoch
    const bId = (await b.keys()).deviceId
    const old = await sealedOp(b, upsert(bId), { epoch: before })
    const claimed = await sealedOp(b, upsert(bId), { epoch: before + 1, deviceSeq: 2 })
    await revokeDevice(a.context, await a.keys(), bId)

    const { registry } = await verifiedKeys(a)
    expect(registry.state.epoch).toBe(before + 1)
    const checker = createOpOriginChecker(registry)
    await expect(checker.check(old)).resolves.toBeUndefined()
    expect((await errorOf(checker.check(claimed))).message).toMatch(/never held/)
    closeAll(devices)
  })

  it("refuses a device whose epochs go backwards along its sequence", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const bId = (await b.keys()).deviceId
    const epoch = (await verifiedKeys(b)).registry.state.epoch
    const later = await sealedOp(b, upsert(bId), { epoch: epoch + 1, deviceSeq: 1 })
    const earlier = await sealedOp(b, upsert(bId), { epoch, deviceSeq: 2 })

    const { registry } = await verifiedKeys(a)
    const checker = createOpOriginChecker(registry)
    await checker.check(later)
    expect((await errorOf(checker.check(earlier))).message).toMatch(/backwards/)
    closeAll(devices)
  })
})
