import "fake-indexeddb/auto"

import { revokeDevice, rotateKeys } from "../enrollment/manage"
import { TEST_SPACE, testContext, testServer } from "../enrollment/test-support"
import { SyncApiError } from "../sync-api"
import { __clearAccountSyncKeyCache } from "../vault-store"
import { SyncDeviceRemovedError, runSyncRound } from "./sync-round"
import { closeAll, syncedDevices, type SyncDevice } from "./test-support"
import type { AccountSyncCursorState } from "./types"

beforeEach(() => __clearAccountSyncKeyCache())
afterEach(() => jest.restoreAllMocks())

const session = (id: string) => ({ id, title: "Plan", createdAt: 1, updatedAt: 1 }) as never

async function pair() {
  const { server, devices } = await syncedDevices(["a", "b"])
  return { server, devices, a: devices[0] as SyncDevice, b: devices[1] as SyncDevice }
}

describe("runSyncRound", () => {
  it("pushes, then pulls until caught up, and says what changed", async () => {
    const { server, devices, a, b } = await pair()
    await a.db.sessions.put(session("s1"))
    const pushed = await a.round()
    expect(pushed).toMatchObject({ pushed: 1, applied: 0, parked: 0, tooLarge: [] })
    expect(pushed.epoch).toBe(server.state()!.epoch)
    expect(pushed.registryHead).toEqual(server.state()!.head)

    const pulled = await b.round()
    expect(pulled).toMatchObject({ pushed: 0, applied: 1 })
    expect([...pulled.tables]).toEqual(["sessions"])
    expect(((await b.db.accountSyncState.get("cursor")) as AccountSyncCursorState).serverSeq).toBe(
      1
    )
    closeAll(devices)
  })

  it("moves its sequence to what the server expects after a gap, once", async () => {
    const { devices, a } = await pair()
    await a.db.accountSyncState.put({
      id: "cursor",
      spaceId: TEST_SPACE,
      serverSeq: 0,
      deviceSeq: 7,
    })
    await a.db.sessions.put(session("s1"))
    expect((await a.round()).pushed).toBe(1)
    expect(await a.db.accountSyncState.get("cursor")).toMatchObject({ deviceSeq: 1 })

    // A second refusal in the same round is the caller's.
    await a.db.sessions.put(session("s2"))
    jest
      .spyOn(a.context.api, "pushOps")
      .mockRejectedValue(new SyncApiError("seq_gap", 409, "gap", { expected: 1 }))
    await expect(a.round()).rejects.toMatchObject({ code: "seq_gap" })
    closeAll(devices)
  })

  it("refreshes its keys when another device rotated mid-push, and pushes under the new epoch", async () => {
    const { server, devices, a, b } = await pair()
    const before = server.state()!.epoch
    await a.db.sessions.put(session("s1"))
    const api = a.context.api
    const original = api.pushOps.bind(api)
    jest.spyOn(api, "pushOps").mockImplementationOnce(async (device, ops) => {
      await rotateKeys(b.context, await b.keys())
      return original(device, ops)
    })
    const result = await a.round()
    expect(result).toMatchObject({ pushed: 1, epoch: before + 1 })
    expect(server.batches.at(-1)!.ops[0]!.epoch).toBe(before + 1)
    expect((await b.round()).applied).toBe(1)
    expect(await b.db.sessions.get("s1")).toMatchObject({ title: "Plan" })
    closeAll(devices)
  })

  it("stops a device that was removed, whether the list or the server says so", async () => {
    const { devices, a, b } = await pair()
    jest
      .spyOn(a.context.api, "pullOps")
      .mockRejectedValueOnce(new SyncApiError("device_revoked", 403, "revoked"))
    await expect(a.round()).rejects.toBeInstanceOf(SyncDeviceRemovedError)

    await revokeDevice(a.context, await a.keys(), (await b.keys()).deviceId)
    await expect(b.round()).rejects.toBeInstanceOf(SyncDeviceRemovedError)
    closeAll(devices)
  })

  it("only pulls when told to, and lets only the first pull wait", async () => {
    const { devices, a, b } = await pair()
    await b.db.sessions.put(session("from-b"))
    await b.round()
    await a.db.sessions.put(session("from-a"))
    const api = a.context.api
    const original = api.pullOps.bind(api)
    const pull = jest
      .spyOn(api, "pullOps")
      .mockImplementationOnce(async (device, after, waitS) => ({
        ...(await original(device, after, waitS)),
        more: true,
      }))
    const result = await a.round({ pullOnly: true, waitS: 25 })
    expect(result).toMatchObject({ pushed: 0, applied: 1 })
    expect(pull.mock.calls.map((call) => call[2])).toEqual([25, 0])
    expect(await a.db.accountSyncOutbox.count()).toBe(1)
    closeAll(devices)
  })

  it("names an account that has no sync devices yet", async () => {
    const { devices, a } = await pair()
    const empty = testContext(testServer(), "lonely")
    await expect(
      runSyncRound(
        { db: a.db, api: empty.api, vault: empty.vault, spaceId: TEST_SPACE, now: Date.now },
        await a.keys()
      )
    ).rejects.toMatchObject({ code: "space_empty" })
    closeAll(devices)
  })
})
