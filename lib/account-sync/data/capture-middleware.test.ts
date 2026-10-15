import "fake-indexeddb/auto"

import Dexie from "dexie"

import { parseHlc } from "@cognia/sync-protocol"
import {
  AccountContentCipher,
  __resetAccountContentCipherForTesting,
  activateAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import { CogniaDB } from "@/lib/db/schema"

import { SETTINGS_VALUE_FIELD, markRemoteTransaction } from "./capture-middleware"
import type { AccountSyncCaptureState } from "./types"

const DEVICE = "dev_" + "A".repeat(26)
let sequence = 0

async function freshDb(name = `capture-test-${++sequence}`): Promise<CogniaDB> {
  const db = new CogniaDB(name, "capture-test")
  await db.open()
  return db
}

async function arm(db: CogniaDB, classes = { content: true, settings: true }): Promise<void> {
  const state: AccountSyncCaptureState = {
    id: "capture",
    spaceId: "s".repeat(43),
    deviceId: DEVICE,
    classes,
    hlc: null,
  }
  await db.accountSyncState.put(state)
}

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: "Plan", createdAt: 1, updatedAt: 1, ...extra } as never
}

afterEach(() => __resetAccountContentCipherForTesting())

describe("capture before enrollment", () => {
  it("records nothing while the database is not armed", async () => {
    const db = await freshDb()
    await db.sessions.put(session("s1"))
    expect(await db.accountSyncOutbox.count()).toBe(0)
    expect(await db.syncFieldClocks.count()).toBe(0)
    db.close()
  })
})

describe("capture once armed", () => {
  it("queues a new row's synced fields with one clock, and never its local ones", async () => {
    const db = await freshDb()
    await arm(db)
    await db.sessions.put(session("s1", { workingDir: "/Users/me/repo", pinned: true }))
    const queued = await db.accountSyncOutbox.get(["sessions", "s1"])
    expect(queued).toMatchObject({
      table: "sessions",
      rowId: "s1",
      fields: ["createdAt", "pinned", "title", "updatedAt"],
      deleted: false,
      rev: 1,
    })
    const clocks = await db.syncFieldClocks.get(["sessions", "s1"])
    expect(Object.keys(clocks!.fields).sort()).toEqual([
      "createdAt",
      "pinned",
      "title",
      "updatedAt",
    ])
    const stamped = new Set(Object.values(clocks!.fields))
    expect(stamped.size).toBe(1)
    expect(parseHlc([...stamped][0])!.deviceId).toBe(DEVICE)
    const state = (await db.accountSyncState.get("capture")) as AccountSyncCaptureState
    expect(state.hlc).not.toBeNull()
    db.close()
  })

  it("takes the changed fields from update() and adds them to what is queued", async () => {
    const db = await freshDb()
    await arm(db)
    await db.sessions.put(session("s1"))
    const before = await db.syncFieldClocks.get(["sessions", "s1"])
    await db.sessions.update("s1", { title: "Renamed", workingDir: "/tmp" })
    const queued = await db.accountSyncOutbox.get(["sessions", "s1"])
    expect(queued!.rev).toBe(2)
    expect(queued!.fields).toEqual(["createdAt", "title", "updatedAt"])
    const after = await db.syncFieldClocks.get(["sessions", "s1"])
    expect(after!.fields.title > before!.fields.title).toBe(true)
    expect(after!.fields.createdAt).toBe(before!.fields.createdAt)
    expect(after!.fields.workingDir).toBeUndefined()
    db.close()
  })

  it("diffs a whole-row put against the previous row", async () => {
    const db = await freshDb()
    await arm(db)
    await db.sessions.put(session("s1", { pinned: false }))
    await db.accountSyncOutbox.clear()
    await db.sessions.put(session("s1", { pinned: true, workingDir: "/elsewhere" }))
    expect((await db.accountSyncOutbox.get(["sessions", "s1"]))!.fields).toEqual(["pinned"])
    await db.accountSyncOutbox.clear()
    await db.sessions.put(session("s1", { pinned: true }))
    expect(await db.accountSyncOutbox.count()).toBe(0)
    db.close()
  })

  it("sends every present synced field of a written message, without reading the old one", async () => {
    const db = await freshDb()
    await arm(db)
    const message = { id: "m1", sessionId: "s1", role: "user", parts: [], createdAt: 5 } as never
    await db.messages.put(message)
    await db.accountSyncOutbox.clear()
    await db.messages.put(message)
    expect((await db.accountSyncOutbox.get(["messages", "m1"]))!.fields).toEqual([
      "createdAt",
      "parts",
      "role",
      "sessionId",
    ])
    db.close()
  })

  it("records deletes, including range deletes, as tombstones", async () => {
    const db = await freshDb()
    await arm(db)
    await db.sessions.bulkPut([session("s1"), session("s2"), session("s3")])
    await db.sessions.delete("s1")
    await db.sessions.where("id").anyOf(["s2", "s3"]).delete()
    await db.sessions.clear()
    for (const id of ["s1", "s2", "s3"]) {
      expect(await db.accountSyncOutbox.get(["sessions", id])).toMatchObject({
        deleted: true,
        fields: [],
      })
      const clocks = await db.syncFieldClocks.get(["sessions", id])
      expect(clocks!.fields).toEqual({})
      expect(clocks!.tombstone).toBeDefined()
    }
    // Writing the row again after a delete queues it as a fresh upsert.
    await db.sessions.put(session("s1"))
    expect(await db.accountSyncOutbox.get(["sessions", "s1"])).toMatchObject({ deleted: false })
    db.close()
  })

  it("skips built-ins and project-bound memories", async () => {
    const db = await freshDb()
    await arm(db)
    await db.characters.put({ id: "c1", name: "Built in", isBuiltIn: true } as never)
    await db.skills.put({ id: "k1", name: "Built in", content: "", source: "builtin" } as never)
    await db.memories.put({ id: "mem1", text: "x", projectId: "p1" } as never)
    await db.memories.put({ id: "mem2", text: "y" } as never)
    expect((await db.accountSyncOutbox.toArray()).map((row) => row.rowId)).toEqual(["mem2"])
    db.close()
  })

  it("splits the settings row per shared key", async () => {
    const db = await freshDb()
    await arm(db)
    await db.settings.put({
      id: "singleton",
      profile: { displayName: "A" },
      gitSettings: {},
    } as never)
    expect(
      (await db.accountSyncOutbox.toArray()).map((row) => [row.table, row.rowId, row.fields])
    ).toEqual([["settings", "profile", [SETTINGS_VALUE_FIELD]]])
    await db.accountSyncOutbox.clear()
    await db.settings.put({
      id: "singleton",
      profile: { displayName: "A" },
      gitSettings: { x: 1 },
    } as never)
    expect(await db.accountSyncOutbox.count()).toBe(0)
    await db.settings.clear()
    expect(await db.accountSyncOutbox.count()).toBe(0)
    db.close()
  })

  it("leaves a class alone while it is switched off", async () => {
    const db = await freshDb()
    await arm(db, { content: false, settings: true })
    await db.sessions.put(session("s1"))
    expect(await db.accountSyncOutbox.count()).toBe(0)
    await db.settings.put({ id: "singleton", profile: { displayName: "B" } } as never)
    expect(await db.accountSyncOutbox.count()).toBe(1)
    db.close()
  })

  it("does not capture what the applier writes", async () => {
    const db = await freshDb()
    await arm(db)
    await db.transaction("rw", db.sessions, async (tx) => {
      markRemoteTransaction(tx.idbtrans)
      await db.sessions.put(session("s1"))
    })
    expect(await db.accountSyncOutbox.count()).toBe(0)
    // The next ordinary transaction is captured again.
    await db.sessions.update("s1", { title: "Local" })
    expect(await db.accountSyncOutbox.count()).toBe(1)
    db.close()
  })

  it("issues distinct, increasing clocks to writes in one transaction", async () => {
    const db = await freshDb()
    await arm(db)
    await db.transaction("rw", db.sessions, async () => {
      await Promise.all([db.sessions.put(session("s1")), db.sessions.put(session("s2"))])
      await db.sessions.update("s1", { title: "Again" })
    })
    const one = await db.syncFieldClocks.get(["sessions", "s1"])
    const two = await db.syncFieldClocks.get(["sessions", "s2"])
    expect(one!.fields.title).not.toBe(two!.fields.createdAt)
    expect(one!.fields.title > one!.fields.createdAt).toBe(true)
    db.close()
  })

  it("keeps every field when concurrent writes in one transaction change the same row", async () => {
    const db = await freshDb()
    await arm(db)
    await db.sessions.put(session("s1"))
    await db.accountSyncOutbox.clear()
    await db.transaction("rw", db.sessions, async () => {
      await Promise.all([
        db.sessions.update("s1", { title: "A" }),
        db.sessions.update("s1", { pinned: true }),
        db.sessions.update("s1", { scratchpad: "notes" }),
      ])
    })
    const queued = await db.accountSyncOutbox.get(["sessions", "s1"])
    expect(queued!.fields).toEqual(["pinned", "scratchpad", "title"])
    expect(queued!.rev).toBe(3)
    const clocks = await db.syncFieldClocks.get(["sessions", "s1"])
    expect(
      new Set([clocks!.fields.title, clocks!.fields.pinned, clocks!.fields.scratchpad]).size
    ).toBe(3)
    db.close()
  })

  it("rolls the capture back with a failed write", async () => {
    const db = await freshDb()
    await arm(db)
    await expect(
      db.transaction("rw", db.sessions, async () => {
        await db.sessions.put(session("s1"))
        throw new Error("abort")
      })
    ).rejects.toThrow("abort")
    expect(await db.accountSyncOutbox.count()).toBe(0)
    expect(await db.syncFieldClocks.count()).toBe(0)
    db.close()
  })
})

describe("capture over an encrypted account database", () => {
  it("sees plaintext rows and stores the clocks encrypted", async () => {
    const name = "cognia-account-acct_capture"
    activateAccountContentCipher(await AccountContentCipher.createForTesting("acct_capture", name))
    const db = await freshDb(name)
    await arm(db)
    await db.sessions.put(session("s1", { title: "Secret plan" }))
    await db.sessions.put(session("s1", { title: "Secret plan v2" }))
    expect((await db.accountSyncOutbox.get(["sessions", "s1"]))!.fields).toContain("title")
    expect(await db.sessionList.get("s1")).toMatchObject({ title: "Secret plan v2" })
    expect((await db.accountSyncOutbox.toArray()).map((row) => row.table)).toEqual(["sessions"])
    expect(await db.syncFieldClocks.get(["sessions", "s1"])).toMatchObject({ table: "sessions" })
    const raw = new Dexie(name)
    await raw.open()
    const stored = (await raw.table("syncFieldClocks").get(["sessions", "s1"])) as Record<
      string,
      unknown
    >
    expect(stored.fields).toBeUndefined()
    expect(stored.__cogniaEncryptedContent).toBeDefined()
    const projected = await raw.table("sessionList").get("s1")
    expect(projected.title).toBeUndefined()
    expect(projected.__cogniaEncryptedContent).toBeDefined()
    raw.close()
    db.close()
  })
})

it("does not capture failed duplicate rows when a partial bulkAdd is caught", async () => {
  const db = await freshDb()
  await arm(db)
  try {
    await db.sessions.put(session("existing", { title: "Original" }))
    await db.accountSyncOutbox.clear()
    const before = await db.syncFieldClocks.get(["sessions", "existing"])
    await db.transaction("rw", db.sessions, async () => {
      await db.sessions
        .bulkAdd([
          session("existing", { title: "Rejected title" }),
          session("new", { title: "Inserted" }),
        ])
        .catch((error) => {
          expect(error).toBeInstanceOf(Dexie.BulkError)
        })
    })
    expect((await db.sessions.get("existing"))?.title).toBe("Original")
    expect((await db.sessions.get("new"))?.title).toBe("Inserted")
    expect((await db.sessionList.get("existing"))?.title).toBe("Original")
    expect(await db.syncFieldClocks.get(["sessions", "existing"])).toEqual(before)
    expect(await db.accountSyncOutbox.get(["sessions", "existing"])).toBeUndefined()
    expect(await db.accountSyncOutbox.get(["sessions", "new"])).toBeDefined()
  } finally {
    db.close()
  }
}, 30000)

it("leaves clocks, queue and capture state unchanged when every caught bulk operation fails", async () => {
  const db = await freshDb()
  await arm(db)
  try {
    await db.sessions.put(session("existing"))
    const queued = await db.accountSyncOutbox.toArray()
    const clocks = await db.syncFieldClocks.toArray()
    const capture = await db.accountSyncState.get("capture")
    await db.transaction("rw", db.sessions, async () => {
      await expect(
        db.sessions.bulkAdd([
          session("existing", { title: "Rejected" }),
          session("existing", { pinned: true }),
        ])
      ).rejects.toBeInstanceOf(Dexie.BulkError)
    })
    expect(await db.accountSyncOutbox.toArray()).toEqual(queued)
    expect(await db.syncFieldClocks.toArray()).toEqual(clocks)
    expect(await db.accountSyncState.get("capture")).toEqual(capture)
  } finally {
    db.close()
  }
})

it("captures only the accepted operation when duplicate keys occur within one bulkAdd", async () => {
  const db = await freshDb()
  await arm(db)
  try {
    await db.transaction("rw", db.sessions, async () => {
      await expect(
        db.sessions.bulkAdd([
          session("duplicate", { title: "Accepted" }),
          session("duplicate", { title: "Rejected", pinned: true }),
          session("other", { title: "Other" }),
        ])
      ).rejects.toBeInstanceOf(Dexie.BulkError)
    })
    expect(await db.sessions.get("duplicate")).toMatchObject({ title: "Accepted" })
    const queued = await db.accountSyncOutbox.get(["sessions", "duplicate"])
    expect(queued).toMatchObject({ rev: 1, fields: ["createdAt", "title", "updatedAt"] })
    expect((await db.syncFieldClocks.get(["sessions", "duplicate"]))!.fields.pinned).toBeUndefined()
    expect(await db.accountSyncOutbox.get(["sessions", "other"])).toBeDefined()
  } finally {
    db.close()
  }
})

it("keeps clocks for intermediate changes when a repeated-key bulkPut restores the old value", async () => {
  const db = await freshDb()
  await arm(db)
  try {
    await db.sessions.put(session("s1", { title: "Original" }))
    const previous = await db.syncFieldClocks.get(["sessions", "s1"])
    await db.accountSyncOutbox.clear()
    await db.sessions.bulkPut([
      session("s1", { title: "Intermediate", pinned: true }),
      session("s1", { title: "Original" }),
    ])
    expect(await db.sessions.get("s1")).toMatchObject({ title: "Original" })
    expect((await db.sessions.get("s1"))!.pinned).toBeUndefined()
    expect((await db.accountSyncOutbox.get(["sessions", "s1"]))!.fields).toEqual([
      "pinned",
      "title",
    ])
    const current = await db.syncFieldClocks.get(["sessions", "s1"])
    expect(current!.fields.title > previous!.fields.title).toBe(true)
    expect(current!.fields.pinned).toBeDefined()
  } finally {
    db.close()
  }
})

it("aborts source and outbox writes if a clock-side mutation fails even when the caller catches it", async () => {
  const db = await freshDb()
  await arm(db)
  db.close()
  db.use({
    stack: "dbcore",
    name: "RejectClockCaptureForTest",
    level: 2.5,
    create(down) {
      return {
        ...down,
        table(name) {
          const table = down.table(name)
          if (name !== "syncFieldClocks") return table
          return {
            ...table,
            mutate: () =>
              Promise.resolve({
                numFailures: 1,
                failures: { 0: new Error("clock storage failed") },
                results: [],
                lastResult: undefined,
              }),
          }
        },
      }
    },
  })
  await db.open()
  try {
    await expect(
      db.transaction("rw", db.sessions, async () => {
        await db.sessions.put(session("s1")).catch(() => undefined)
      })
    ).rejects.toBeDefined()
    expect(await db.sessions.get("s1")).toBeUndefined()
    expect(await db.sessionList.get("s1")).toBeUndefined()
    expect(await db.accountSyncOutbox.count()).toBe(0)
    expect(await db.syncFieldClocks.count()).toBe(0)
  } finally {
    db.close()
  }
})
