import "fake-indexeddb/auto"

/**
 * Devices of one person replicating their data through the in-memory server
 * (ADR-0215 phase 3): capture → push → pull → merge, every merge rule, epoch
 * changes and removal mid-stream, a lying server, and random interleavings
 * that must converge.
 */
import { encodeHlc, type OpHeader } from "@cognia/sync-protocol"

import { revokeDevice } from "../enrollment/manage"
import { __clearAccountSyncKeyCache } from "../vault-store"
import { OpIntegrityError, parkedCounts } from "./applier"
import { OpOriginError } from "./op-origin"
import { SyncDeviceRemovedError } from "./sync-round"
import {
  closeAll,
  sealedOp,
  settleAll,
  syncedDevices,
  verifiedKeys,
  type SyncDevice,
} from "./test-support"
import type { AccountSyncCaptureState } from "./types"

beforeEach(() => __clearAccountSyncKeyCache())

const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: "Plan", createdAt: 1, updatedAt: 1, ...extra }) as never

/** Runs `write` with `Date.now()` pinned, so clocks are ordered as the test says. */
async function at<T>(ms: number, write: () => Promise<T>): Promise<T> {
  const spy = jest.spyOn(Date, "now").mockReturnValue(ms)
  try {
    return await write()
  } finally {
    spy.mockRestore()
  }
}

async function syncedView(device: SyncDevice, table: "sessions" | "characters" | "memories") {
  const rows = (await device.db.table(table).toArray()) as Record<string, unknown>[]
  return rows
    .map((row) => {
      const { syncRevision: _r, workingDir: _w, ...rest } = row
      return rest
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

describe("replicating data", () => {
  it("carries rows, settings keys and deletes to the other devices, never local fields", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    await a.db.sessions.put(session("s1", { workingDir: "/Users/a/repo", pinned: true }))
    await a.db.characters.put({
      id: "c1",
      name: "Writer",
      systemPrompt: "Write",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    await a.db.skills.put({ id: "k0", name: "Built-in", content: "", source: "builtin" } as never)
    await a.db.memories.put({
      id: "m1",
      text: "Prefers tea",
      tags: [],
      vectorDocId: "vec_a",
    } as never)
    await a.db.settings.put({
      id: "singleton",
      profile: { displayName: "Ada" },
      gitSettings: { x: 1 },
    } as never)

    expect((await a.round()).pushed).toBe(4)
    const pulled = await b.round()
    expect(pulled.applied).toBe(4)
    expect([...pulled.tables].sort()).toEqual(["characters", "memories", "sessions", "settings"])

    expect(await b.db.sessions.get("s1")).toMatchObject({ title: "Plan", pinned: true })
    expect((await b.db.sessions.get("s1"))!.workingDir).toBeUndefined()
    expect(await b.db.characters.get("c1")).toMatchObject({ name: "Writer" })
    expect(await b.db.skills.get("k0")).toBeUndefined()
    const memory = await b.db.memories.get("m1")
    expect(memory).toMatchObject({ text: "Prefers tea" })
    expect(memory!.vectorDocId).toBeUndefined()
    const settings = (await b.db.settings.get("singleton")) as unknown as Record<string, unknown>
    expect(settings.profile).toEqual({ displayName: "Ada" })
    expect(settings.gitSettings).toBeUndefined()
    // B applied remote writes without capturing them as its own.
    expect(await b.db.accountSyncOutbox.count()).toBe(0)

    await b.db.sessions.delete("s1")
    await settleAll(devices)
    expect(await a.db.sessions.get("s1")).toBeUndefined()
    closeAll(devices)
  })

  it("merges concurrent edits per field, and the later write wins a field both changed", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    await at(1_000, () => a.db.sessions.put(session("s1")))
    await settleAll(devices)

    await at(2_000, () => a.db.sessions.update("s1", { title: "From A", pinned: true }))
    await at(3_000, () => b.db.sessions.update("s1", { title: "From B", scratchpad: "notes" }))
    await settleAll(devices)

    for (const device of devices) {
      expect(await device.db.sessions.get("s1")).toMatchObject({
        title: "From B",
        pinned: true,
        scratchpad: "notes",
      })
    }
    expect(await syncedView(a, "sessions")).toEqual(await syncedView(b, "sessions"))
    closeAll(devices)
  })

  it("keeps a row deleted against an older edit, and keeps it alive for a newer one", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    await at(1_000, () => a.db.sessions.bulkPut([session("old"), session("new")]))
    await settleAll(devices)

    // `old`: A edits at 2000, B deletes at 3000 → deleted everywhere.
    // `new`: B deletes at 2000, A edits at 3000 → the row survives everywhere, whole.
    // Each device writes in clock order: a clock never moves back, so a later
    // write pinned to an earlier time would still be stamped after the first.
    await at(2_000, () => a.db.sessions.update("old", { title: "Edited" }))
    await at(2_000, () => b.db.sessions.delete("new"))
    await at(3_000, () => a.db.sessions.update("new", { pinned: true }))
    await at(3_000, () => b.db.sessions.delete("old"))
    await settleAll(devices)

    for (const device of devices) {
      expect(await device.db.sessions.get("old")).toBeUndefined()
      expect(await device.db.sessions.get("new")).toMatchObject({ title: "Plan", pinned: true })
    }
    closeAll(devices)
  })

  it("sends a streamed message once, with its final text", async () => {
    const { server, devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    for (let i = 1; i <= 20; i++) {
      await a.db.messages.put({
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "text", text: "word ".repeat(i) }],
        createdAt: 5,
      } as never)
    }
    const before = server.batches.length
    expect((await a.round()).pushed).toBe(1)
    expect(server.batches.length).toBe(before + 1)
    await b.round()
    expect((await b.db.messages.get("m1"))!.parts).toEqual([
      { type: "text", text: "word ".repeat(20) },
    ])
    closeAll(devices)
  })

  it("applies another device's chat into a database that encrypts its content, and back", async () => {
    // As in the app: B's rows and clocks are encrypted at rest, so every read
    // inside the apply transaction decrypts while holding it open.
    const { devices } = await syncedDevices(["a", "b"], undefined, { encrypted: "b" })
    const [a, b] = devices as [SyncDevice, SyncDevice]
    expect(b.db.name.startsWith("cognia-account-")).toBe(true)
    await a.db.sessions.put(session("s1"))
    await a.db.messages.put({
      id: "m1",
      sessionId: "s1",
      role: "user",
      parts: [{ type: "text", text: "hello from a" }],
      createdAt: 5,
    } as never)
    await settleAll(devices)
    expect((await b.db.sessions.get("s1"))!.title).toBe("Plan")
    expect((await b.db.messages.get("m1"))!.parts).toEqual([{ type: "text", text: "hello from a" }])

    // A second write to rows B already holds reads them back (and their clocks) to merge.
    await a.db.messages.put({
      id: "m1",
      sessionId: "s1",
      role: "user",
      parts: [{ type: "text", text: "hello again" }],
      createdAt: 5,
    } as never)
    await b.db.messages.put({
      id: "m2",
      sessionId: "s1",
      role: "assistant",
      parts: [{ type: "text", text: "reply from b" }],
      createdAt: 6,
    } as never)
    await settleAll(devices)
    expect((await b.db.messages.get("m1"))!.parts).toEqual([{ type: "text", text: "hello again" }])
    expect((await a.db.messages.get("m2"))!.parts).toEqual([{ type: "text", text: "reply from b" }])
    closeAll(devices)
  })

  it("leaves a class alone on a device that switched it off", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const capture = (await a.db.accountSyncState.get("capture")) as AccountSyncCaptureState
    await a.db.accountSyncState.put({ ...capture, classes: { content: false, settings: true } })
    await a.db.sessions.put(session("s1"))
    await a.db.settings.put({ id: "singleton", profile: { displayName: "Ada" } } as never)
    await settleAll(devices)
    expect(await b.db.sessions.get("s1")).toBeUndefined()
    expect(
      ((await b.db.settings.get("singleton")) as never as { profile: unknown }).profile
    ).toEqual({
      displayName: "Ada",
    })
    closeAll(devices)
  })
})

describe("epoch changes and removal", () => {
  it("keeps syncing across a rotation another device made, parking ops until it has the key", async () => {
    const { devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    await a.db.sessions.put(session("s1"))
    await settleAll(devices)
    // B joined by recovery, so the epoch is already 2; rotate once more from B.
    const { rotateKeys } = await import("../enrollment/manage")
    await rotateKeys(b.context, await b.keys())
    await b.db.sessions.update("s1", { title: "After rotation" })
    const pushed = await b.round()
    expect(pushed.epoch).toBe(3)
    const pulled = await a.round()
    expect(pulled.epoch).toBe(3)
    expect(await a.db.sessions.get("s1")).toMatchObject({ title: "After rotation" })
    expect(await parkedCounts(a.db)).toEqual({ schema: 0, key: 0 })
    closeAll(devices)
  })

  it("stops a removed device, and the rest carry on under the new epoch", async () => {
    const { devices } = await syncedDevices(["a", "b", "c"])
    const [a, b, c] = devices as [SyncDevice, SyncDevice, SyncDevice]
    await revokeDevice(a.context, await a.keys(), (await b.keys()).deviceId)
    await b.db.sessions.put(session("from-b"))
    await expect(b.round()).rejects.toBeInstanceOf(SyncDeviceRemovedError)
    await a.db.sessions.put(session("from-a"))
    await settleAll([a, c])
    expect(await c.db.sessions.get("from-a")).toBeDefined()
    expect(await c.db.sessions.get("from-b")).toBeUndefined()
    closeAll(devices)
  })
})

describe("a lying server", () => {
  async function sealedBy(device: SyncDevice, overrides: Partial<OpHeader> = {}) {
    const { deviceId } = await device.keys()
    const hlc = { ms: 9_000_000_000_000, c: 0 }
    return sealedOp(
      device,
      {
        t: "sessions",
        id: "forged",
        k: "upsert",
        f: { title: ["Forged", encodeHlc({ ...hlc, deviceId })] },
      },
      { hlc, ...overrides }
    )
  }

  it("cannot slip in an op whose signature or device is not from this space", async () => {
    const { server, devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const op = await sealedBy(b)
    server.batches.push({
      firstSeq: 1,
      lastSeq: 1,
      deviceId: op.deviceId,
      ops: [{ ...op, deviceSeq: 2 }],
    })
    await expect(a.round()).rejects.toBeInstanceOf(OpOriginError)
    expect(await a.db.sessions.get("forged")).toBeUndefined()
    closeAll(devices)
  })

  it("cannot replay a removed device's op under a key it never held", async () => {
    const { server, devices } = await syncedDevices(["a", "b", "c"])
    const [a, b, c] = devices as [SyncDevice, SyncDevice, SyncDevice]
    const before = (await verifiedKeys(b)).registry.state.epoch
    // B signs an op that claims the epoch its removal will open, sealed under
    // the only key it ever held, and the server slips it in after the removal.
    const forged = await sealedBy(b, { epoch: before + 1 })
    await revokeDevice(a.context, await a.keys(), (await b.keys()).deviceId)
    await c.round()
    const seq = (server.batches.at(-1)?.lastSeq ?? 0) + 1
    server.batches.push({ firstSeq: seq, lastSeq: seq, deviceId: forged.deviceId, ops: [forged] })
    await expect(c.round()).rejects.toBeInstanceOf(OpOriginError)
    expect(await c.db.sessions.get("forged")).toBeUndefined()
    closeAll(devices)
  })

  it("refuses an op whose ciphertext was swapped", async () => {
    const { server, devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    await b.db.sessions.put(session("s1"))
    await b.round()
    const batch = server.batches.at(-1)!
    const other = await sealedBy(b)
    batch.ops[0] = { ...batch.ops[0]!, ct: other.ct }
    await expect(a.round()).rejects.toThrow()
    expect(await a.db.sessions.get("s1")).toBeUndefined()
    closeAll(devices)
  })

  it("parks an op from a newer sync schema instead of dropping or misreading it", async () => {
    const { server, devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    const keys = await b.keys()
    const op = await sealedOp(
      b,
      {
        t: "sessions",
        id: "future",
        k: "upsert",
        f: { title: ["From the future", encodeHlc({ ms: 1, c: 0, deviceId: keys.deviceId })] },
      },
      { schemaVer: 2, hlc: { ms: 1, c: 0 } }
    )
    await b.context.api.pushOps(keys, [op])
    const result = await a.round()
    expect(result.parked).toBe(1)
    expect(await parkedCounts(a.db)).toEqual({ schema: 1, key: 0 })
    expect(await a.db.sessions.get("future")).toBeUndefined()
    expect(server.batches).toHaveLength(1)
    closeAll(devices)
  })

  it("never lets a server-side integrity failure change local data", async () => {
    const { server, devices } = await syncedDevices(["a", "b"])
    const [a, b] = devices as [SyncDevice, SyncDevice]
    await b.db.sessions.bulkPut([session("s1"), session("s2")])
    expect((await b.round()).pushed).toBe(2)
    const before = await a.db.accountSyncState.get("cursor")
    // One batch: a sound op, then one that is not an op at all.
    const batch = server.batches.at(-1)!
    expect(batch.ops).toHaveLength(2)
    batch.ops[1] = { deviceId: batch.ops[1]!.deviceId, garbage: true } as never

    await expect(a.round()).rejects.toBeInstanceOf(OpIntegrityError)
    expect(await a.db.sessions.get("s1")).toBeUndefined()
    expect(await a.db.sessions.get("s2")).toBeUndefined()
    expect(await a.db.syncFieldClocks.count()).toBe(0)
    expect(await a.db.accountSyncState.get("cursor")).toEqual(before)
    closeAll(devices)
  })
})

/** Mulberry32: a small seeded generator, so a failing interleaving reproduces. */
function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("random interleavings", () => {
  it.each([1, 2, 3, 4, 5])("converge (seed %i)", async (seed) => {
    const random = seeded(seed)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const { devices } = await syncedDevices(["a", "b", "c"])
    const ids = ["s1", "s2", "s3", "s4"]
    let clock = 10_000
    for (let step = 0; step < 60; step++) {
      const device = pick(devices)
      const id = pick(ids)
      clock += Math.floor(random() * 3) // equal times happen: the device id breaks the tie
      const roll = random()
      await at(clock, async () => {
        if (roll < 0.15) await device.db.sessions.delete(id)
        else if (roll < 0.35)
          await device.db.sessions.put(session(id, { title: `t${step}`, pinned: random() < 0.5 }))
        else if (roll < 0.6) await device.db.sessions.update(id, { title: `u${step}` })
        else if (roll < 0.8) await device.db.sessions.update(id, { scratchpad: `n${step}` })
        else await device.round()
      })
    }
    await settleAll(devices, 10)
    const [first, ...others] = await Promise.all(
      devices.map((device) => syncedView(device, "sessions"))
    )
    for (const other of others) expect(other).toEqual(first)
    closeAll(devices)
  })
})
