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

  it.each([1, 300, 600])(
    "bounds outbox reads while draining %i rows",
    async (count) => {
      const { a, devices, deps, pushed } = await setup()
      await a.db.sessions.bulkPut(Array.from({ length: count }, (_, index) => session(`s${index}`)))
      const readSizes: number[] = []
      const orderBy = a.db.accountSyncOutbox.orderBy.bind(a.db.accountSyncOutbox)
      const querySpy = jest.spyOn(a.db.accountSyncOutbox, "orderBy").mockImplementation((index) => {
        const collection = orderBy(index)
        const toArray = collection.toArray.bind(collection)
        collection.toArray = (async () => {
          const values = await toArray()
          readSizes.push(values.length)
          return values
        }) as typeof collection.toArray
        return collection
      })
      try {
        expect((await pushOutbox(deps())).pushed).toBe(count)
        expect(pushed.flat().map((op) => op.deviceSeq)).toEqual(
          Array.from({ length: count }, (_, index) => index + 1)
        )
        expect(Math.max(...readSizes)).toBeLessThanOrEqual(512)
        expect(await a.db.accountSyncOutbox.count()).toBe(0)
      } finally {
        querySpy.mockRestore()
        closeAll(devices)
      }
    },
    60_000
  )

  it("passes more than one page of oversized rows without starving a later valid row", async () => {
    const { a, devices, deps, pushed, open } = await setup()
    const oversized = Array.from(
      { length: 513 },
      (_, index) => `a${String(index).padStart(3, "0")}`
    )
    await a.db.sessions.bulkPut([...oversized.map((id) => session(id)), session("z-valid")])
    // Share one large string in the read fixture instead of storing 300 MiB in IndexedDB.
    const largeTitle = "x".repeat(600 * 1024)
    const expandTitle = (row: { id: string; title: string }) =>
      row && row.id.startsWith("a") ? { ...row, title: largeTitle } : row
    a.db.sessions.hook("reading", expandTitle)
    try {
      expect(await pushOutbox(deps())).toEqual({
        pushed: 1,
        dropped: 0,
        tooLarge: oversized.map((id) => `sessions:${id}`),
      })
      expect(await open(pushed[0]![0]!)).toMatchObject({ id: "z-valid", k: "upsert" })
      expect(await a.db.accountSyncOutbox.count()).toBe(oversized.length)
    } finally {
      a.db.sessions.hook("reading").unsubscribe(expandTitle)
      closeAll(devices)
    }
  }, 60_000)

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

// Opt-in complete local push-path experiment; no wall-clock assertion in CI.
const performanceExperiment = process.env.ACCOUNT_SYNC_BENCHMARK ? it : it.skip
performanceExperiment(
  "performance experiment: complete outbox drain",
  async () => {
    const { createHash } = await import("node:crypto")
    const { writeFileSync } = await import("node:fs")
    const { performance } = await import("node:perf_hooks")
    const paired = process.env.ACCOUNT_SYNC_BENCHMARK_SOURCE === "paired"
    const baselineModule = process.env.ACCOUNT_SYNC_BENCHMARK_BASELINE_MODULE
    if (process.env.ACCOUNT_SYNC_BENCHMARK_SOURCE && !baselineModule)
      throw new Error(
        "Use the account-sync report's run-diagnostic.mjs to load the frozen baseline"
      )
    const baselineDrain = baselineModule ? (await import(baselineModule)).pushOutbox : undefined
    const sampleCount = Number(process.env.ACCOUNT_SYNC_BENCHMARK_SAMPLES ?? 10)
    const rows = Number(process.env.ACCOUNT_SYNC_BENCHMARK_ROWS ?? 2048)
    const samples: Record<string, unknown>[] = []
    const workloads = Array.from({ length: sampleCount + 1 }, (_, index) => index - 1).flatMap(
      (sample) =>
        (paired
          ? ["baseline", "result"]
          : [process.env.ACCOUNT_SYNC_BENCHMARK_SOURCE === "baseline" ? "baseline" : "result"]
        ).map((implementation) => ({ sample, implementation }))
    )
    for (const { sample, implementation } of workloads) {
      const drain = implementation === "baseline" ? baselineDrain! : pushOutbox
      const { a, devices, deps, open, stored } = await setup()
      const expected = Array.from({ length: rows }, (_, index) => ({
        id: `s${String(index).padStart(5, "0")}`,
        title: `Conversation ${index}`,
      }))
      // Seed from one genuine captured write; setup is outside the timed path.
      await a.db.sessions.put(session(expected[0]!.id, { title: expected[0]!.title }))
      const templateClock = (await a.db.syncFieldClocks.get(["sessions", expected[0]!.id]))!
      const templateOutbox = (await a.db.accountSyncOutbox.get(["sessions", expected[0]!.id]))!
      const capture = (await a.db.accountSyncState.get("capture"))!
      await a.db.accountSyncState.delete("capture")
      await a.db.sessions.bulkPut(expected.map((row) => session(row.id, { title: row.title })))
      await a.db.syncFieldClocks.bulkPut(
        expected.map((row) => ({ ...templateClock, rowId: row.id }))
      )
      await a.db.accountSyncOutbox.bulkPut(
        expected.map((row) => ({ ...templateOutbox, rowId: row.id }))
      )
      await a.db.accountSyncState.put(capture)
      console.log("ACCOUNT_SYNC_SEEDED", sample)
      let materializedRows = 0
      let largestRead = 0
      const orderBy = a.db.accountSyncOutbox.orderBy.bind(a.db.accountSyncOutbox)
      const querySpy = jest.spyOn(a.db.accountSyncOutbox, "orderBy").mockImplementation((index) => {
        const collection = orderBy(index)
        const toArray = collection.toArray.bind(collection)
        collection.toArray = (async () => {
          const values = await toArray()
          materializedRows += values.length
          largestRead = Math.max(largestRead, values.length)
          return values
        }) as typeof collection.toArray
        return collection
      })
      const sent: Op[] = []
      let wireBytes = 0
      const started = performance.now()
      const result = await drain(
        deps({
          push: async (ops) => {
            sent.push(...ops)
            wireBytes += Buffer.byteLength(JSON.stringify(ops))
            return stored(ops)
          },
        })
      )
      const durationMs = performance.now() - started
      querySpy.mockRestore()
      expect(result).toEqual({ pushed: rows, dropped: 0, tooLarge: [] })
      expect(await a.db.accountSyncOutbox.count()).toBe(0)
      const actual: { id: string; title: unknown }[] = []
      for (let index = 0; index < sent.length; index++) {
        expect(sent[index]!.deviceSeq).toBe(index + 1)
        const payload = await open(sent[index]!)
        if (payload.k !== "upsert") throw new Error("Expected an upsert")
        actual.push({ id: payload.id, title: payload.f.title![0] })
      }
      expect(actual).toEqual(expected)
      const digest = createHash("sha256").update(JSON.stringify(actual)).digest("hex")
      const record = {
        sample,
        implementation,
        rows,
        durationMs,
        materializedRows,
        largestRead,
        wireBytes,
        ops: sent.length,
        digest,
      }
      if (sample >= 0) samples.push(record)
      console.log("ACCOUNT_SYNC_SAMPLE", JSON.stringify(record))
      await a.db.delete()
      closeAll(devices)
    }
    writeFileSync(
      `docs/reports/multi-device-performance-2026-10-07/account-sync/${process.env.ACCOUNT_SYNC_BENCHMARK}.json`,
      JSON.stringify({ samples }, null, 2) + "\n"
    )
  },
  600_000
)
