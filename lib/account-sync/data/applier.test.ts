import "fake-indexeddb/auto"

import { encodeHlc, signOp, type Op, type OpPayload } from "@cognia/sync-protocol"

import { rotateKeys } from "../enrollment/manage"
import { TEST_SPACE } from "../enrollment/test-support"
import { __clearAccountSyncKeyCache } from "../vault-store"
import {
  OpIntegrityError,
  applyBatches,
  parkedCounts,
  replayInbox,
  type ApplyDeps,
} from "./applier"
import { createOpOriginChecker } from "./op-origin"
import { closeAll, sealedOp, syncedDevices, verifiedKeys, type SyncDevice } from "./test-support"
import type { AccountSyncCaptureState, AccountSyncCursorState } from "./types"

beforeEach(() => __clearAccountSyncKeyCache())

const NOW = 5_000_000

async function setup() {
  const { devices } = await syncedDevices(["a", "b"])
  const [a, b] = devices as [SyncDevice, SyncDevice]
  const bId = (await b.keys()).deviceId
  const depsFor = async (device: SyncDevice = a): Promise<ApplyDeps> => {
    const { keys, registry, chain } = await verifiedKeys(device)
    return {
      db: device.db,
      spaceId: TEST_SPACE,
      deviceId: keys.deviceId,
      registry,
      chain,
      origin: createOpOriginChecker(registry),
      now: () => NOW,
    }
  }
  const at = (ms: number, deviceId = bId) => encodeHlc({ ms, c: 0, deviceId })
  let seq = 0
  const fromB = (payload: OpPayload, header: Parameters<typeof sealedOp>[2] = {}) =>
    sealedOp(b, payload, { deviceSeq: ++seq, ...header })
  const batch = (ops: Op[], firstSeq = 1) => ({
    firstSeq,
    lastSeq: firstSeq + ops.length - 1,
    ops,
  })
  return { a, b, bId, devices, depsFor, at, fromB, batch }
}

describe("applyBatches", () => {
  it("writes winning synced fields, keeps unknown ones aside, and moves the cursor and clock", async () => {
    const { a, devices, depsFor, at, fromB, batch } = await setup()
    const op = await fromB(
      {
        t: "sessions",
        id: "s1",
        k: "upsert",
        f: { title: ["Plan", at(4_000)], workingDir: ["/elsewhere", at(4_000)] },
        u: { future: [42, at(4_000)] },
      },
      { hlc: { ms: 4_000, c: 0 } }
    )
    const result = await applyBatches(await depsFor(), [batch([op], 3)])

    expect(result).toEqual({ applied: 1, parked: 0, tables: new Set(["sessions"]) })
    expect(await a.db.sessions.get("s1")).toEqual({ id: "s1", title: "Plan" })
    const clocks = await a.db.syncFieldClocks.get(["sessions", "s1"])
    expect(clocks).toMatchObject({
      fields: { title: at(4_000) },
      unknown: { future: [42, at(4_000)] },
    })
    expect(clocks!.fields.workingDir).toBeUndefined()
    expect(await a.db.accountSyncOutbox.count()).toBe(0)
    expect(((await a.db.accountSyncState.get("cursor")) as AccountSyncCursorState).serverSeq).toBe(
      3
    )
    const capture = (await a.db.accountSyncState.get("capture")) as AccountSyncCaptureState
    expect(capture.hlc!.ms).toBeGreaterThanOrEqual(4_000)
    closeAll(devices)
  })

  it("skips this device's own ops and a table this build does not sync, but moves past them", async () => {
    const { a, devices, depsFor, at, fromB, batch } = await setup()
    const own = await sealedOp(a, {
      t: "sessions",
      id: "mine",
      k: "upsert",
      f: { title: ["Mine", at(1_000, (await a.keys()).deviceId)] },
    })
    const unsynced = await fromB({
      t: "workflows",
      id: "w1",
      k: "upsert",
      f: { name: ["W", at(1_000)] },
    })
    const result = await applyBatches(await depsFor(), [batch([own, unsynced])])
    expect(result.applied).toBe(0)
    expect(await a.db.sessions.get("mine")).toBeUndefined()
    expect(((await a.db.accountSyncState.get("cursor")) as AccountSyncCursorState).serverSeq).toBe(
      2
    )
    closeAll(devices)
  })

  it("deletes a row against older fields, and keeps it for a newer field, asking for a resend", async () => {
    const { a, devices, depsFor, at, fromB, batch } = await setup()
    const deps = await depsFor()
    await applyBatches(deps, [
      batch([
        await fromB({ t: "sessions", id: "old", k: "upsert", f: { title: ["Old", at(1_000)] } }),
        await fromB({ t: "sessions", id: "new", k: "upsert", f: { title: ["New", at(3_000)] } }),
      ]),
    ])
    await applyBatches(deps, [
      batch(
        [
          await fromB({ t: "sessions", id: "old", k: "delete", at: at(2_000) }),
          await fromB({ t: "sessions", id: "new", k: "delete", at: at(2_000) }),
        ],
        3
      ),
    ])
    expect(await a.db.sessions.get("old")).toBeUndefined()
    expect(await a.db.syncFieldClocks.get(["sessions", "old"])).toMatchObject({
      fields: {},
      tombstone: at(2_000),
    })
    expect(await a.db.sessions.get("new")).toMatchObject({ title: "New" })
    expect(await a.db.accountSyncOutbox.get(["sessions", "new"])).toMatchObject({
      resend: true,
      deleted: false,
    })

    // An upsert older than the tombstone does not bring the row back; a newer one does.
    await applyBatches(deps, [
      batch(
        [
          await fromB({
            t: "sessions",
            id: "old",
            k: "upsert",
            f: { title: ["Stale", at(1_500)] },
          }),
          await fromB({ t: "sessions", id: "old", k: "upsert", f: { title: ["Back", at(2_500)] } }),
        ],
        5
      ),
    ])
    expect(await a.db.sessions.get("old")).toEqual({ id: "old", title: "Back" })
    closeAll(devices)
  })

  it("applies shared settings keys to the settings row and ignores every other key", async () => {
    const { a, devices, depsFor, at, fromB, batch } = await setup()
    await applyBatches(await depsFor(), [
      batch([
        await fromB({
          t: "settings",
          id: "profile",
          k: "upsert",
          f: { value: [{ displayName: "Ada" }, at(1_000)] },
        }),
        await fromB({
          t: "settings",
          id: "gitSettings",
          k: "upsert",
          f: { value: [{ x: 1 }, at(1_000)] },
        }),
      ]),
    ])
    const row = (await a.db.settings.get("singleton")) as unknown as Record<string, unknown>
    expect(row.profile).toEqual({ displayName: "Ada" })
    expect(row.gitSettings).toBeUndefined()
    expect(row.updatedAt).toBe(NOW)
    closeAll(devices)
  })

  it("parks ops from a newer schema or a newer epoch, and replays them once it can", async () => {
    const { a, devices, depsFor, at, fromB, batch } = await setup()
    const before = await depsFor()
    const future = await fromB(
      { t: "sessions", id: "future", k: "upsert", f: { title: ["Future", at(1_000)] } },
      { schemaVer: 2 }
    )
    await rotateKeys(a.context, await a.keys())
    __clearAccountSyncKeyCache()
    const rotated = await fromB({
      t: "sessions",
      id: "rotated",
      k: "upsert",
      f: { title: ["R", at(1_000)] },
    })
    expect(rotated.epoch).toBe(before.registry.state.epoch + 1)

    expect(await applyBatches(before, [batch([future, rotated])])).toMatchObject({
      applied: 0,
      parked: 2,
    })
    expect(await parkedCounts(a.db)).toEqual({ schema: 1, key: 1 })
    expect(((await a.db.accountSyncState.get("cursor")) as AccountSyncCursorState).serverSeq).toBe(
      2
    )

    // Still on the old list: nothing to replay yet.
    expect((await replayInbox(before)).applied).toBe(0)
    const replayed = await replayInbox(await depsFor())
    expect(replayed).toEqual({ applied: 1, parked: 0, tables: new Set(["sessions"]) })
    expect(await a.db.sessions.get("rotated")).toMatchObject({ title: "R" })
    expect(await parkedCounts(a.db)).toEqual({ schema: 1, key: 0 })
    closeAll(devices)
  })

  it("refuses a malformed op and a signed op that does not decrypt, writing nothing", async () => {
    const { a, b, devices, depsFor, at, fromB, batch } = await setup()
    const deps = await depsFor()
    const good = await fromB({
      t: "sessions",
      id: "s1",
      k: "upsert",
      f: { title: ["T", at(1_000)] },
    })
    await expect(
      applyBatches(deps, [batch([good, { nope: true } as never])])
    ).rejects.toBeInstanceOf(OpIntegrityError)

    const other = await fromB({
      t: "sessions",
      id: "s2",
      k: "upsert",
      f: { title: ["U", at(1_000)] },
    })
    const { sig: _sig, ...unsigned } = good
    const garbled = await signOp((await b.keys()).sign.privateKey, TEST_SPACE, {
      ...unsigned,
      ct: other.ct,
    })
    await expect(applyBatches(deps, [batch([garbled])])).rejects.toBeInstanceOf(OpIntegrityError)

    expect(await a.db.sessions.count()).toBe(0)
    expect(await a.db.accountSyncState.get("cursor")).toBeUndefined()
    closeAll(devices)
  })
})
