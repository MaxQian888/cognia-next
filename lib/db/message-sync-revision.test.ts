import "fake-indexeddb/auto"
import Dexie from "dexie"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  __resetAccountContentCipherForTesting,
} from "@/lib/accounts/content-cipher"
import { createEncryptedContentMiddleware } from "./encrypted-content-middleware"
import {
  backfillMessageSyncRevision,
  createMessageSyncRevisionMiddleware,
} from "./message-sync-revision"

const name = "cognia-account-sync-test"
const schema = {
  workflowRuns: "id,startedAt,completedAt,[syncActivityAt+id]",
  messages: "id,[syncRevision+id]",
  messageSyncClock: "id",
}
function open() {
  const db = new Dexie(name)
  db.version(226).stores(schema).upgrade(backfillMessageSyncRevision)
  db.use(createMessageSyncRevisionMiddleware())
  return db
}
afterEach(async () => {
  await Dexie.delete(name)
  __resetAccountContentCipherForTesting()
})

it("orders same-timestamp updates, imports, and concurrent writes in one transaction", async () => {
  const db = open()
  try {
    await db.table("messages").add({ id: "a", createdAt: 1, text: "partial" })
    await db.transaction("rw", db.table("messages"), async () => {
      await Promise.all([
        db.table("messages").update("a", { text: "complete" }),
        db.table("messages").bulkPut([
          { id: "b", createdAt: 1 },
          { id: "c", createdAt: 1 },
        ]),
      ])
    })
    const rows = await db.table("messages").orderBy("[syncRevision+id]").toArray()
    expect(new Set(rows.map((row) => row.syncRevision)).size).toBe(3)
    expect(rows.every((row) => row.syncRevision > 1)).toBe(true)
    expect(await db.table("messages").get("a")).toMatchObject({ text: "complete", createdAt: 1 })
    expect(await db.table("messageSyncClock").get("singleton")).toEqual({
      id: "singleton",
      revision: 4,
    })
  } finally {
    db.close()
  }
})

it("keeps the watermark after deleting all messages and reopening", async () => {
  const first = open()
  await first.table("messages").put({ id: "a" })
  await first.table("messages").clear()
  first.close()
  const second = open()
  try {
    await second.table("messages").put({ id: "b", syncRevision: 900 })
    expect((await second.table("messages").get("b")).syncRevision).toBe(2)
  } finally {
    second.close()
  }
})

it("rolls the message and its clock back together", async () => {
  const db = open()
  try {
    await expect(
      db.transaction("rw", db.table("messages"), async () => {
        await db.table("messages").put({ id: "rolled-back" })
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")
    expect(await db.table("messageSyncClock").get("singleton")).toBeUndefined()
    await db.table("messages").bulkPut([])
    await db.table("messages").put({ id: "committed" })
    expect((await db.table("messages").get("committed")).syncRevision).toBe(1)
  } finally {
    db.close()
  }
})

it("v226 backfills existing encrypted rows without opening their content", async () => {
  const old = new Dexie(name)
  old.version(225).stores({ messages: "id" })
  const envelope = { version: 1, ciphertext: "unchanged-encrypted-payload" }
  await old.table("messages").bulkPut([
    { id: "a", createdAt: 5, __cogniaEncryptedContent: envelope },
    { id: "b", createdAt: 9, text: "plain" },
  ])
  old.close()
  const db = open()
  try {
    expect(await db.table("messages").get("a")).toEqual({
      id: "a",
      createdAt: 5,
      __cogniaEncryptedContent: envelope,
      syncRevision: 1,
    })
    await db.table("messages").update("b", { text: "changed" })
    expect((await db.table("messages").get("b")).syncRevision).toBe(3)
  } finally {
    db.close()
  }
})

it("indexes workflow activity on creation and completion without a full-row scan", async () => {
  const db = open()
  try {
    await db
      .table("workflowRuns")
      .put({ id: "run", startedAt: 10, workflowSnapshot: { value: "kept" } })
    await db.table("workflowRuns").update("run", { completedAt: 20 })
    expect(
      await db.table("workflowRuns").where("[syncActivityAt+id]").above([19, ""]).toArray()
    ).toMatchObject([{ id: "run", syncActivityAt: 20, workflowSnapshot: { value: "kept" } }])
    await db.table("workflowRuns").delete("run")
    expect(await db.table("workflowRuns").count()).toBe(0)
  } finally {
    db.close()
  }
})

it("does not rewind an existing clock when backfill is repeated", async () => {
  const db = open()
  try {
    await db.table("messages").put({ id: "a" })
    await db.table("messages").put({ id: "b" })
    await db.table("messages").delete("b")
    await db.transaction("rw", db.tables, backfillMessageSyncRevision)
    expect((await db.table("messageSyncClock").get("singleton")).revision).toBe(3)
    expect((await db.table("messages").get("a")).syncRevision).toBe(3)
  } finally {
    db.close()
  }
})

it("keeps content encrypted while indexing updates from the outer encryption middleware", async () => {
  activateAccountContentCipher(await AccountContentCipher.createForTesting("sync-test", name))
  const db = open()
  db.use(createEncryptedContentMiddleware(name))
  const raw = new Dexie(name)
  try {
    await db.table("messages").put({ id: "private", text: "private first text", createdAt: 1 })
    await db.table("messages").update("private", { text: "private updated text" })
    expect(
      await db.table("messages").where("[syncRevision+id]").above([1, ""]).toArray()
    ).toMatchObject([{ id: "private", syncRevision: 2, text: "private updated text" }])
    await raw.open()
    const stored = await raw.table("messages").get("private")
    expect(stored.syncRevision).toBe(2)
    expect(stored.text).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain("private updated text")
    expect(stored.__cogniaEncryptedContent).toBeDefined()
  } finally {
    raw.close()
    db.close()
  }
})

it("replaces imported duplicate and missing revisions with unique local positions", async () => {
  const old = new Dexie(name)
  old.version(225).stores({ messages: "id" })
  await old.table("messages").bulkPut(
    Array.from({ length: 505 }, (_, index) => ({
      id: String(index).padStart(4, "0"),
      ...(index < 2 ? {} : { syncRevision: 1 }),
    }))
  )
  old.close()
  const db = open()
  try {
    const first = await db.table("messages").orderBy("[syncRevision+id]").limit(500).toArray()
    const second = await db
      .table("messages")
      .where("[syncRevision+id]")
      .above([first.at(-1).syncRevision, Dexie.maxKey])
      .toArray()
    expect(first.length + second.length).toBe(505)
    expect(new Set([...first, ...second].map((row) => row.syncRevision)).size).toBe(505)
    expect((await db.table("messageSyncClock").get("singleton")).revision).toBe(505)
  } finally {
    db.close()
  }
})

it.each(["clock-read", "cursor", "row-update", "clock-write"])(
  "rejects a migration %s storage failure",
  async (stage) => {
    const failure = new Error(`storage failure: ${stage}`)
    const request = (result: unknown, failed: boolean) => {
      const value = { result, error: failure, onsuccess: () => {}, onerror: () => {} }
      queueMicrotask(() => (failed ? value.onerror() : value.onsuccess()))
      return value
    }
    const rawStore = {
      get: () => request(undefined, stage === "clock-read"),
      put: () => request(undefined, stage === "clock-write"),
      openCursor: () =>
        request(
          stage === "row-update"
            ? {
                value: { id: "legacy" },
                update: () => request(undefined, true),
                continue: jest.fn(),
              }
            : null,
          stage === "cursor"
        ),
    }
    const transaction = {
      idbtrans: {
        objectStoreNames: { contains: (table: string) => table === "messages" },
        objectStore: () => rawStore,
      },
    } as unknown as Parameters<typeof backfillMessageSyncRevision>[0]
    await expect(backfillMessageSyncRevision(transaction)).rejects.toBe(failure)
  }
)

it("aborts the message transaction if persisting its clock fails", async () => {
  const db = open()
  const failure = new Error("clock disk write failed")
  db.use({
    stack: "dbcore",
    name: "FailClockPersistence",
    level: 0,
    create(down) {
      return {
        ...down,
        table(name) {
          const table = down.table(name)
          if (name !== "messageSyncClock") return table
          return {
            ...table,
            mutate: () =>
              Dexie.Promise.resolve({
                numFailures: 1,
                failures: { 0: failure },
                results: [],
                lastResult: undefined,
              }),
          }
        },
      }
    },
  })
  try {
    await expect(db.table("messages").put({ id: "uncommitted" })).rejects.toThrow()
    expect(await db.table("messages").get("uncommitted")).toBeUndefined()
    expect(await db.table("messageSyncClock").get("singleton")).toBeUndefined()
  } finally {
    db.close()
  }
})
