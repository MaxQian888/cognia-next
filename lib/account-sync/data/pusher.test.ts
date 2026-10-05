import "fake-indexeddb/auto"

import { MAX_OPS_PER_PUSH, decryptOpPayload, opKey, type Op } from "@cognia/sync-protocol"

import { TEST_SPACE } from "../enrollment/test-support"
import { __clearAccountSyncKeyCache } from "../vault-store"
import { pushOutbox, type PushDeps } from "./pusher"
import { closeAll, syncedDevices, verifiedKeys, type SyncDevice } from "./test-support"

beforeEach(() => __clearAccountSyncKeyCache())

const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: "Plan", createdAt: 1, updatedAt: 1, ...extra }) as never

async function setup() {
  const { devices } = await syncedDevices(["a"])
  const a = devices[0] as SyncDevice
  const verified = await verifiedKeys(a)
  const pushed: Op[][] = []
  let serverSeq = 0
  const stored = (ops: Op[]) => {
    const firstSeq = serverSeq + 1
    serverSeq += ops.length
    return { deviceSeq: ops.at(-1)!.deviceSeq, firstSeq, lastSeq: serverSeq }
  }
  const deps = (overrides: Partial<PushDeps> = {}): PushDeps => ({
    db: a.db,
    spaceId: TEST_SPACE,
    device: verified.keys,
    chain: verified.chain,
    epoch: verified.registry.state.epoch,
    push: async (ops) => {
      pushed.push(ops)
      return stored(ops)
    },
    ...overrides,
  })
  const open = async (op: Op) =>
    decryptOpPayload(await opKey(verified.chain.get(op.epoch)!, TEST_SPACE), TEST_SPACE, op)
  const titleOf = async (op: Op) => {
    const payload = await open(op)
    return payload.k === "upsert" ? payload.f.title?.[0] : undefined
  }
  return { a, devices, deps, pushed, open, titleOf, stored, verified }
}

describe("pushOutbox", () => {
  it("sends each changed row once with its current values, and moves the device sequence", async () => {
    const { a, devices, deps, pushed, open } = await setup()
    await a.db.sessions.put(session("s1"))
    await a.db.sessions.update("s1", { title: "Draft" })
    await a.db.sessions.update("s1", { title: "Final" })
    await a.db.characters.put({ id: "c1", name: "Gone", createdAt: 1, updatedAt: 1 } as never)
    await a.db.characters.delete("c1")
    await a.db.settings.put({ id: "singleton", profile: { displayName: "Ada" } } as never)

    expect(await pushOutbox(deps())).toEqual({ pushed: 3, dropped: 0, tooLarge: [] })
    const ops = pushed.flat()
    expect(ops.map((op) => op.deviceSeq)).toEqual([1, 2, 3])
    const payloads = await Promise.all(ops.map(open))
    const byTable = Object.fromEntries(payloads.map((payload) => [payload.t, payload]))
    expect(byTable.characters).toMatchObject({ id: "c1", k: "delete" })
    expect(byTable.sessions).toMatchObject({ id: "s1", k: "upsert" })
    expect((byTable.sessions as { f: Record<string, [unknown, string]> }).f.title![0]).toBe("Final")
    expect(byTable.settings).toMatchObject({
      id: "profile",
      k: "upsert",
      f: { value: [{ displayName: "Ada" }, expect.any(String)] },
    })
    expect(ops.find((op) => op.deviceSeq === 3)!.cls).toBe(
      payloads[2]!.t === "settings" ? "s" : "c"
    )
    expect(await a.db.accountSyncOutbox.count()).toBe(0)
    expect(await a.db.accountSyncState.get("cursor")).toMatchObject({ deviceSeq: 3 })
    closeAll(devices)
  })

  it("sends a change again under fresh numbers when the server already held the numbers it used", async () => {
    const { a, devices, deps, titleOf, verified } = await setup()
    const api = a.context.api
    await a.db.sessions.put(session("s1"))
    // The server stores the push, but its answer is lost on the way back.
    await expect(
      pushOutbox(
        deps({
          push: async (ops) => {
            await api.pushOps(verified.keys, ops)
            throw new TypeError("connection reset")
          },
        })
      )
    ).rejects.toThrow("connection reset")
    await a.db.sessions.update("s1", { title: "Newer" })

    // Rebuilt from the newer row under the same number: acknowledged, not stored.
    const sent: Op[] = []
    const result = await pushOutbox(
      deps({
        push: async (ops) => {
          sent.push(...ops)
          return api.pushOps(verified.keys, ops)
        },
      })
    )
    expect(sent.map((op) => op.deviceSeq)).toEqual([1, 2])
    expect(result.pushed).toBe(1)
    expect(await titleOf(sent[1]!)).toBe("Newer")
    expect(await a.db.accountSyncOutbox.count()).toBe(0)
    expect(await a.db.accountSyncState.get("cursor")).toMatchObject({ deviceSeq: 2 })
    closeAll(devices)
  })

  it("drops entries with nothing left to send without pushing", async () => {
    const { a, devices, deps, pushed } = await setup()
    await a.db.accountSyncOutbox.put({
      table: "sessions",
      rowId: "ghost",
      fields: ["title"],
      deleted: false,
      rev: 1,
      since: 0,
    })
    expect(await pushOutbox(deps())).toEqual({ pushed: 0, dropped: 1, tooLarge: [] })
    expect(pushed).toEqual([])
    expect(await a.db.accountSyncOutbox.count()).toBe(0)
    closeAll(devices)
  })

  it("keeps an entry that changed while its push was in flight", async () => {
    const { a, devices, deps, titleOf, stored } = await setup()
    await a.db.sessions.put(session("s1"))
    const sent: Op[] = []
    let writes = 0
    const result = await pushOutbox(
      deps({
        push: async (ops) => {
          sent.push(...ops)
          if (writes++ === 0) await a.db.sessions.update("s1", { title: "Later" })
          return stored(ops)
        },
      })
    )
    // The entry outlived the first push, so the same call sends it again.
    expect(result.pushed).toBe(2)
    const titles = await Promise.all(sent.map(titleOf))
    expect(titles).toEqual(["Plan", "Later"])
    expect(await a.db.accountSyncOutbox.count()).toBe(0)
    closeAll(devices)
  })

  it("holds back a row too large for one op and pushes the rest", async () => {
    const { a, devices, deps } = await setup()
    await a.db.sessions.bulkPut([
      session("big", { title: "x".repeat(600 * 1024) }),
      session("small"),
    ])
    expect(await pushOutbox(deps())).toEqual({ pushed: 1, dropped: 0, tooLarge: ["sessions:big"] })
    expect((await a.db.accountSyncOutbox.toArray()).map((entry) => entry.rowId)).toEqual(["big"])
    closeAll(devices)
  })

  it("splits a large outbox into pushes of at most 256 ops with consecutive sequence numbers", async () => {
    const { a, devices, deps, pushed } = await setup()
    await a.db.sessions.bulkPut(
      Array.from({ length: MAX_OPS_PER_PUSH + 44 }, (_, index) =>
        session(`s${String(index).padStart(3, "0")}`)
      )
    )
    expect((await pushOutbox(deps())).pushed).toBe(MAX_OPS_PER_PUSH + 44)
    expect(pushed.map((ops) => ops.length)).toEqual([MAX_OPS_PER_PUSH, 44])
    expect(pushed.flat().map((op) => op.deviceSeq)).toEqual(
      Array.from({ length: MAX_OPS_PER_PUSH + 44 }, (_, index) => index + 1)
    )
    closeAll(devices)
  })

  it("re-sends the whole row after surviving a delete, with fields it does not know", async () => {
    const { a, devices, deps, pushed, open } = await setup()
    await a.db.sessions.put(session("s1", { pinned: true }))
    await pushOutbox(deps())
    const clocks = (await a.db.syncFieldClocks.get(["sessions", "s1"]))!
    await a.db.syncFieldClocks.put({ ...clocks, unknown: { future: [1, clocks.fields.title!] } })
    await a.db.accountSyncOutbox.put({
      table: "sessions",
      rowId: "s1",
      fields: [],
      deleted: false,
      resend: true,
      rev: 1,
      since: 0,
    })
    await pushOutbox(deps())
    const payload = (await open(pushed.at(-1)![0]!)) as { f: Record<string, unknown>; u?: unknown }
    expect(Object.keys(payload.f)).toEqual(expect.arrayContaining(["title", "pinned"]))
    expect(payload.u).toEqual({ future: [1, clocks.fields.title] })
    closeAll(devices)
  })

  it("refuses to seal without the key of the epoch it pushes under", async () => {
    const { a, devices, deps } = await setup()
    await a.db.sessions.put(session("s1"))
    await expect(pushOutbox(deps({ epoch: 99 }))).rejects.toThrow("no key for the current epoch 99")
    expect(await a.db.accountSyncOutbox.count()).toBe(1)
    closeAll(devices)
  })
})
