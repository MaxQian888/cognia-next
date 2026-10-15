import "fake-indexeddb/auto"
import Dexie from "dexie"
import type { ChatSession } from "@cognia/agent-config-types"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  getActiveAccountContentCipher,
  lockAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import { createEncryptedContentMiddleware } from "./encrypted-content-middleware"
import {
  createSessionListMiddleware,
  createSessionListWitnessMiddleware,
  readVerifiedSessionListRows,
  ensureSessionListReady,
  projectSessionListRow,
  SESSION_LIST_READY_ID,
} from "./session-list"

const name = "cognia-account-session-list-test"
let db: Dexie
const row = (id: string, patch: Partial<ChatSession> = {}): ChatSession => ({
  id,
  title: `Secret title ${id}`,
  createdAt: 1,
  updatedAt: 2,
  projectId: "p1",
  systemPrompt: "Private prompt",
  transcriptRevision: 1,
  ...patch,
})

function connection(): Dexie {
  const result = new Dexie(name)
  result.version(1).stores({
    sessions: "id, updatedAt, projectId, [projectId+updatedAt], __cogniaEncryptedContent.iv",
    sessionList: "id, updatedAt, workspaceKey, [workspaceKey+updatedAt]",
    storageLayout: "id",
  })
  result.use(createEncryptedContentMiddleware(name))
  result.use(createSessionListMiddleware())
  result.use(createSessionListWitnessMiddleware())
  return result
}

function raw(table: string, id: string): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.backendDB().transaction(table).objectStore(table).get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

beforeEach(async () => {
  await Dexie.delete(name)
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("session-list-test", name)
  )
  db = connection()
  await db.open()
})
afterEach(async () => {
  db.close()
  await Dexie.delete(name)
  lockAccountContentCipher()
})

it("stores only list fields and encrypts titles, previews, routing payloads and cwd", async () => {
  const session = row("a", { lastMessagePreview: "private preview", workingDir: "/private/path" })
  await db.table("sessions").put(session)
  expect(await db.table("sessionList").get("a")).toEqual(projectSessionListRow(session))
  const stored = await raw("sessionList", "a")
  expect(stored?.__cogniaEncryptedContent).toBeDefined()
  expect(stored?.title).toBeUndefined()
  expect(stored?.lastMessagePreview).toBeUndefined()
  expect(stored?.workingDir).toBeUndefined()
  expect(stored?.systemPrompt).toBeUndefined()
  expect(stored?.transcriptRevision).toBeUndefined()
  expect(await db.table("sessions").get("a")).toEqual(session)
})

it("leaves the projection ciphertext untouched for source-only patches and whole-row puts", async () => {
  const session = row("a")
  await db.table("sessions").put(session)
  const before = await raw("sessionList", "a")
  await db.table("sessions").update("a", { transcriptRevision: 2, systemPrompt: "new secret" })
  expect(await raw("sessionList", "a")).toEqual(before)
  await db
    .table("sessions")
    .put({ ...session, transcriptRevision: 3, systemPrompt: "another secret" })
  expect(await raw("sessionList", "a")).toEqual(before)
  await db.table("sessions").update("a", { title: "Renamed", pinned: true, folderId: "folder" })
  expect(await db.table("sessionList").get("a")).toMatchObject({
    title: "Renamed",
    pinned: true,
    folderId: "folder",
  })
})

it("tracks add, duplicate keys, partial bulk failures, modify and delete ranges", async () => {
  await db.table("sessions").add(row("a"))
  await db.transaction("rw", "sessions", async () => {
    await db
      .table("sessions")
      .bulkAdd([row("a", { title: "must not replace" }), row("b")])
      .catch((error) => {
        expect(error).toBeInstanceOf(Dexie.BulkError)
      })
  })
  expect((await db.table("sessionList").get("a")).title).toBe("Secret title a")
  expect(await db.table("sessionList").get("b")).toBeDefined()
  await db.table("sessions").bulkPut([row("b", { title: "first" }), row("b", { title: "last" })])
  expect((await db.table("sessionList").get("b")).title).toBe("last")
  await db
    .table("sessions")
    .bulkPut([row("b", { title: "intermediate" }), row("b", { title: "last" })])
  expect((await db.table("sessionList").get("b")).title).toBe("last")
  await db.table("sessions").where("projectId").equals("p1").modify({ archivedAt: 20 })
  expect((await db.table("sessionList").toArray()).every((value) => value.archivedAt === 20)).toBe(
    true
  )
  await db.table("sessions").where("id").below("b").delete()
  expect(await db.table("sessionList").toCollection().primaryKeys()).toEqual(["b"])
  await db.table("sessions").clear()
  expect(await db.table("sessionList").count()).toBe(0)
})

it("serializes projection work after concurrent source writes without losing the final row", async () => {
  await db.table("sessions").put(row("a"))
  await db.transaction("rw", "sessions", async () => {
    await Promise.all([
      db.table("sessions").put(row("a", { title: "first", projectId: "p2" })),
      db.table("sessions").put(row("a", { title: "last", projectId: undefined })),
      db.table("sessions").put(row("b")),
    ])
  })
  const source = await db.table("sessions").get("a")
  expect(await db.table("sessionList").get("a")).toEqual(projectSessionListRow(source))
  expect(await db.table("sessionList").count()).toBe(2)
})

it("rolls back both tables when the caller aborts", async () => {
  await db.table("sessions").put(row("a"))
  await expect(
    db.transaction("rw", "sessions", async () => {
      await db.table("sessions").put(row("a", { title: "aborted" }))
      throw new Error("abort")
    })
  ).rejects.toThrow("abort")
  expect((await db.table("sessions").get("a")).title).toBe("Secret title a")
  expect((await db.table("sessionList").get("a")).title).toBe("Secret title a")
})

it("aborts the source write if projection persistence fails", async () => {
  db.close()
  db.use({
    stack: "dbcore",
    name: "FailProjection",
    level: 3.5,
    create: (down) => ({
      ...down,
      table: (tableName) => {
        const table = down.table(tableName)
        return tableName !== "sessionList"
          ? table
          : {
              ...table,
              mutate: () =>
                Promise.resolve({
                  numFailures: 1,
                  failures: { 0: new Error("projection unavailable") },
                  lastResult: undefined,
                }),
            }
      },
    }),
  })
  await db.open()
  await expect(db.table("sessions").put(row("a"))).rejects.toThrow("projection unavailable")
  expect(await db.table("sessions").count()).toBe(0)
})

it("rebuilds atomically and idempotently, including records from another connection", async () => {
  const other = connection()
  try {
    await other.open()
    await other.table("sessions").bulkPut([row("a"), row("b", { projectId: "" })])
    const source = await raw("sessions", "a")
    await db.table("sessionList").clear()
    await ensureSessionListReady(db)
    expect(await db.table("sessionList").count()).toBe(2)
    expect((await db.table("sessionList").get("b")).workspaceKey).toBe("")
    expect(await raw("sessions", "a")).toEqual(source)
    const projection = await raw("sessionList", "a")
    await ensureSessionListReady(db)
    expect(await raw("sessionList", "a")).toEqual(projection)
    expect(await db.table("storageLayout").get(SESSION_LIST_READY_ID)).toEqual({
      id: SESSION_LIST_READY_ID,
      version: 2,
    })
  } finally {
    other.close()
  }
})

describe("bounded witness backfill", () => {
  async function seedPreviousProjection() {
    const previous = new Dexie(name)
    previous.use(createEncryptedContentMiddleware(name))
    const rawConnection = new Dexie(name)
    try {
      await previous.open()
      await previous
        .table("sessions")
        .bulkPut(Array.from({ length: 501 }, (_, index) => row(String(index).padStart(4, "0"))))
      await rawConnection.open()
      await rawConnection.table("sessions").put(row("0999", { title: "Legacy plaintext" }))
      await db.table("sessionList").put(projectSessionListRow(row("orphan")))
      await db.table("storageLayout").bulkPut([
        { id: SESSION_LIST_READY_ID, version: 1 },
        { id: "session-list-source:orphan", sessionListId: "orphan", sessionListIv: "obsolete" },
        { id: "unrelated-marker", version: 7 },
      ])
      return {
        sessions: await rawConnection.table("sessions").toArray(),
        projection: await rawConnection.table("sessionList").toArray(),
        markers: await rawConnection.table("storageLayout").toArray(),
      }
    } finally {
      previous.close()
      rawConnection.close()
    }
  }

  it("collects witnesses from source pages without rereading across 500-row boundaries", async () => {
    const before = await seedPreviousProjection()
    const cipher = getActiveAccountContentCipher(name)!
    const encrypt = jest.spyOn(cipher, "encrypt")
    const decrypt = jest.spyOn(cipher, "decrypt")
    const get = jest.spyOn(IDBObjectStore.prototype, "get")
    const getAll = jest.spyOn(IDBObjectStore.prototype, "getAll")
    try {
      await ensureSessionListReady(db)
      const sourceGets = get.mock.calls.filter(
        ([key], index) => get.mock.contexts[index].name === "sessions" && typeof key === "string"
      )
      expect(sourceGets).toHaveLength(0)
      const sourcePages = getAll.mock.calls.flatMap(([query, count], index) => {
        const options = query as { query?: IDBKeyRange; count?: number } | undefined
        const range = query instanceof IDBKeyRange ? query : options?.query
        return getAll.mock.contexts[index].name === "sessions"
          ? [{ lower: range?.lower, upper: range?.upper, count: count ?? options?.count }]
          : []
      })
      expect(sourcePages).toEqual([
        { lower: undefined, upper: undefined, count: 500 },
        { lower: "0499", upper: undefined, count: 500 },
        { lower: "0999", upper: undefined, count: 500 },
      ])
      expect(decrypt.mock.calls.filter(([table]) => table === "sessions")).toHaveLength(501)
      expect(encrypt.mock.calls.filter(([table]) => table === "sessionList")).toHaveLength(502)
      expect(encrypt.mock.calls.filter(([table]) => table === "sessions")).toHaveLength(0)
      get.mockRestore()
      getAll.mockRestore()
      const rawConnection = new Dexie(name)
      try {
        await rawConnection.open()
        expect(await rawConnection.table("sessions").toArray()).toEqual(before.sessions)
        const projected = await rawConnection.table("sessionList").toArray()
        expect(projected).toHaveLength(502)
        expect(projected.every((item) => item.__cogniaEncryptedContent)).toBe(true)
        expect(JSON.stringify(projected)).not.toMatch(
          /Secret title|Legacy plaintext|Private prompt/
        )
      } finally {
        rawConnection.close()
      }
      const projected = await db.table("sessionList").toArray()
      expect(projected.map((item) => item.id)).toEqual(before.sessions.map((item) => item.id))
      expect(projected.find((item) => item.id === "0999").title).toBe("Legacy plaintext")
      const witnesses = await db
        .table("storageLayout")
        .where("id")
        .startsWith("session-list-source:")
        .toArray()
      expect(witnesses).toEqual(
        before.sessions.slice(0, 501).map((item) => ({
          id: `session-list-source:${item.id}`,
          sessionListId: item.id,
          sessionListIv: item.__cogniaEncryptedContent.iv,
        }))
      )
      expect(await db.table("storageLayout").get("unrelated-marker")).toEqual({
        id: "unrelated-marker",
        version: 7,
      })
      expect(await db.table("storageLayout").get(SESSION_LIST_READY_ID)).toEqual({
        id: SESSION_LIST_READY_ID,
        version: 2,
      })
    } finally {
      get.mockRestore()
      getAll.mockRestore()
      encrypt.mockRestore()
      decrypt.mockRestore()
    }
  })

  it.each(["query", "decrypt"] as const)(
    "rolls back all pages and readiness when a later source page fails during %s",
    async (failure) => {
      const before = await seedPreviousProjection()
      const cipher = getActiveAccountContentCipher(name)!
      const originalDecrypt = cipher.decrypt.bind(cipher)
      const decrypt = jest.spyOn(cipher, "decrypt").mockImplementation((...args) => {
        if (failure === "decrypt" && args[0] === "sessions" && args[1] === "0500") {
          return Promise.reject(new Error("raw witness page unavailable"))
        }
        return originalDecrypt(...args)
      })
      const originalGetAll = IDBObjectStore.prototype.getAll
      const getAll = jest.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
        this: IDBObjectStore,
        query,
        count
      ) {
        const range =
          query instanceof IDBKeyRange
            ? query
            : (query as { query?: IDBKeyRange } | undefined)?.query
        if (
          failure === "query" &&
          this.name === "sessions" &&
          range?.lower === "0499" &&
          range.upper === undefined
        ) {
          throw new Error("raw witness page unavailable")
        }
        return originalGetAll.call(this, query, count)
      })
      try {
        await expect(ensureSessionListReady(db)).rejects.toThrow("raw witness page unavailable")
      } finally {
        getAll.mockRestore()
        decrypt.mockRestore()
      }
      const rawConnection = new Dexie(name)
      try {
        await rawConnection.open()
        expect(await rawConnection.table("sessions").toArray()).toEqual(before.sessions)
        expect(await rawConnection.table("sessionList").toArray()).toEqual(before.projection)
        expect(await rawConnection.table("storageLayout").toArray()).toEqual(before.markers)
      } finally {
        rawConnection.close()
      }
      await ensureSessionListReady(db)
      expect(await db.table("sessionList").count()).toBe(502)
      expect(await db.table("storageLayout").get(SESSION_LIST_READY_ID)).toEqual({
        id: SESSION_LIST_READY_ID,
        version: 2,
      })
    }
  )

  it.each(["none", "witness", "projection"] as const)(
    "overlaps witnesses with held projection encryption and rolls back %s failures",
    async (failure) => {
      const before = await seedPreviousProjection()
      let enabled = true
      let witnessStarted = false
      let signalWitness!: () => void
      const witnessAttempt = new Promise<void>((resolve) => {
        signalWitness = resolve
      })
      db.close()
      db.use({
        stack: "dbcore",
        name: "ObserveBackfillWitnessOverlap",
        level: 1.25,
        create: (down) => ({
          ...down,
          table(name) {
            const table = down.table(name)
            if (name !== "storageLayout") return table
            return {
              ...table,
              mutate(request) {
                const isWitness =
                  enabled &&
                  request.type === "put" &&
                  request.values.some((value) =>
                    String(value.id).startsWith("session-list-source:")
                  )
                if (!isWitness) return table.mutate(request)
                witnessStarted = true
                if (failure === "witness") {
                  signalWitness()
                  return Dexie.Promise.resolve({
                    numFailures: 1,
                    failures: { 0: new Error("witness write unavailable") },
                    lastResult: undefined,
                  })
                }
                return table.mutate(request).then((result) => {
                  signalWitness()
                  return result
                })
              },
            }
          },
        }),
      })
      await db.open()
      const cipher = getActiveAccountContentCipher(name)!
      const originalEncrypt = cipher.encrypt.bind(cipher)
      let signalProjection!: () => void
      const projectionStarted = new Promise<void>((resolve) => {
        signalProjection = resolve
      })
      let releaseProjection!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseProjection = resolve
      })
      let completedEncryptions = 0
      const encrypt = jest.spyOn(cipher, "encrypt").mockImplementation((...args) => {
        if (args[0] !== "sessionList") return originalEncrypt(...args)
        signalProjection()
        return gate.then(() => {
          if (failure === "projection") throw new Error("projection encryption unavailable")
          completedEncryptions++
          return originalEncrypt(...args)
        })
      })
      const outcome = ensureSessionListReady(db).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      )
      let result: { error: unknown }
      try {
        await projectionStarted
        expect(witnessStarted).toBe(true)
        await witnessAttempt
        expect(completedEncryptions).toBe(0)
      } finally {
        releaseProjection()
        result = await outcome
        encrypt.mockRestore()
        enabled = false
      }
      if (failure === "none") {
        expect(result.error).toBeUndefined()
        expect(await db.table("sessionList").count()).toBe(502)
      } else {
        expect(String(result.error)).toMatch(
          failure === "witness" ? /witness write unavailable/ : /projection encryption unavailable/
        )
        const rawConnection = new Dexie(name)
        try {
          await rawConnection.open()
          expect(await rawConnection.table("sessions").toArray()).toEqual(before.sessions)
          expect(await rawConnection.table("sessionList").toArray()).toEqual(before.projection)
          expect(await rawConnection.table("storageLayout").toArray()).toEqual(before.markers)
        } finally {
          rawConnection.close()
        }
        await ensureSessionListReady(db)
      }
      expect(await db.table("storageLayout").get(SESSION_LIST_READY_ID)).toEqual({
        id: SESSION_LIST_READY_ID,
        version: 2,
      })
    }
  )

  it("keeps custom callers without witness middleware at readiness version 1", async () => {
    await seedPreviousProjection()
    const custom = new Dexie(name)
    custom.use(createEncryptedContentMiddleware(name))
    try {
      await custom.open()
      await ensureSessionListReady(custom)
      expect(await custom.table("sessionList").count()).toBe(502)
      expect(await custom.table("storageLayout").get(SESSION_LIST_READY_ID)).toEqual({
        id: SESSION_LIST_READY_ID,
        version: 1,
      })
      expect(
        await custom.table("storageLayout").where("id").startsWith("session-list-source:").count()
      ).toBe(0)
      await ensureSessionListReady(db)
      expect(await db.table("storageLayout").get(SESSION_LIST_READY_ID)).toEqual({
        id: SESSION_LIST_READY_ID,
        version: 2,
      })
    } finally {
      custom.close()
    }
  })
})

it("rejects reads and writes while locked and does not mark a failed backfill ready", async () => {
  await db.table("sessions").put(row("a"))
  lockAccountContentCipher()
  await expect(db.table("sessionList").toArray()).rejects.toThrow(/locked/)
  await expect(db.table("sessions").update("a", { title: "locked" })).rejects.toThrow(/locked/)
  await expect(ensureSessionListReady(db)).rejects.toThrow(/locked/)
  expect(await db.table("storageLayout").get(SESSION_LIST_READY_ID)).toBeUndefined()
})

it("initializes a freshly activated database lazily before its first verified list", async () => {
  await db.table("sessions").put(row("fresh"))
  expect(await db.table("storageLayout").get(SESSION_LIST_READY_ID)).toBeUndefined()
  expect(await readVerifiedSessionListRows(db)).toEqual([projectSessionListRow(row("fresh"))])
  expect(await db.table("storageLayout").get(SESSION_LIST_READY_ID)).toEqual({
    id: SESSION_LIST_READY_ID,
    version: 2,
  })
})

it("overlays encrypted writes from an older connection, including unchanged timestamps and project moves", async () => {
  await db.table("sessions").bulkPut([row("rename"), row("remove"), row("move"), row("stay")])
  await ensureSessionListReady(db)
  await readVerifiedSessionListRows(db)
  const old = new Dexie(name)
  old.use(createEncryptedContentMiddleware(name))
  await old.open()
  try {
    await old.table("sessions").put(row("rename", { title: "Old build changed title" }))
    await old.table("sessions").delete("remove")
    await old.table("sessions").put(row("move", { projectId: "p2" }))
    await old.table("sessions").put(row("new", { projectId: undefined }))
    const all = await readVerifiedSessionListRows(db)
    expect(all?.map((value) => value.id)).toEqual(["stay", "rename", "new", "move"])
    expect(all?.find((value) => value.id === "rename")?.title).toBe("Old build changed title")
    expect((await readVerifiedSessionListRows(db, "p1"))?.map((value) => value.id)).toEqual([
      "stay",
      "rename",
      "new",
    ])
    expect((await readVerifiedSessionListRows(db, "p2"))?.map((value) => value.id)).toEqual([
      "move",
      "new",
    ])
    // Correctness does not depend on a broadcaster or an open modern connection.
    db.close()
    await old.table("sessions").put(row("rename", { title: "Changed while closed" }))
    db = connection()
    await db.open()
    expect(
      (await readVerifiedSessionListRows(db))?.find((value) => value.id === "rename")?.title
    ).toBe("Changed while closed")
  } finally {
    old.close()
  }
})

it("reads plaintext legacy rows authoritatively when no ciphertext witness exists", async () => {
  const legacy = new Dexie(name)
  await legacy.open()
  try {
    await legacy.table("sessions").put(row("plain"))
    await ensureSessionListReady(db)
    await legacy.table("sessions").put(row("plain", { title: "Changed plaintext" }))
    expect((await readVerifiedSessionListRows(db))?.[0].title).toBe("Changed plaintext")
  } finally {
    legacy.close()
  }
})

it("rebuilds stale v241 projection before certifying ciphertext witnesses", async () => {
  await db.table("sessions").put(row("a"))
  await db.table("sessionList").put(projectSessionListRow(row("a", { title: "stale" })))
  await db.table("storageLayout").put({ id: SESSION_LIST_READY_ID, version: 1 })
  await ensureSessionListReady(db)
  expect((await readVerifiedSessionListRows(db))?.[0].title).toBe("Secret title a")
})

it("keeps the witness and source atomic when the surrounding transaction aborts", async () => {
  await db.table("sessions").put(row("a"))
  const before = await db.table("storageLayout").toArray()
  await expect(
    db.transaction("rw", "sessions", async () => {
      await db.table("sessions").update("a", { transcriptRevision: 2 })
      throw new Error("abort witness")
    })
  ).rejects.toThrow("abort witness")
  expect(await db.table("storageLayout").toArray()).toEqual(before)
})

it("does not certify a custom database without the raw witness middleware", async () => {
  const missing = new Dexie("session-list-missing-index")
  missing.version(250).stores({ sessions: "id, updatedAt", sessionList: "id", storageLayout: "id" })
  try {
    await missing.open()
    await missing.table("storageLayout").put({ id: SESSION_LIST_READY_ID, version: 1 })
    expect(await readVerifiedSessionListRows(missing)).toBeUndefined()
  } finally {
    await missing.delete()
  }
})

it("does not certify stale projection after an old write followed by a current source-only patch", async () => {
  await db.table("sessions").put(row("a"))
  await ensureSessionListReady(db)
  await readVerifiedSessionListRows(db)
  const old = new Dexie(name)
  old.use(createEncryptedContentMiddleware(name))
  await old.open()
  try {
    await old.table("sessions").put(row("a", { title: "Old title change" }))
    await db.table("sessions").update("a", { transcriptRevision: 2 })
    expect((await db.table("sessionList").get("a")).title).toBe("Secret title a")
    expect((await readVerifiedSessionListRows(db))?.[0].title).toBe("Old title change")
  } finally {
    old.close()
  }
})

it("uses encrypted projection without decrypting unchanged source rows", async () => {
  await db.table("sessions").bulkPut([row("a"), row("b")])
  await ensureSessionListReady(db)
  const decrypt = jest.spyOn(getActiveAccountContentCipher(name)!, "decrypt")
  try {
    expect(await readVerifiedSessionListRows(db)).toHaveLength(2)
    expect(decrypt.mock.calls.filter(([table]) => table === "sessions")).toHaveLength(0)
    expect(decrypt.mock.calls.filter(([table]) => table === "sessionList")).toHaveLength(2)
  } finally {
    decrypt.mockRestore()
  }
})

it.each(["put", "delete"] as const)(
  "aborts the outer transaction when witness %s fails even if the caller catches the source error",
  async (operation) => {
    await db.table("sessions").put(row("a"))
    await ensureSessionListReady(db)
    const before = {
      source: await raw("sessions", "a"),
      projection: await raw("sessionList", "a"),
      witnesses: await db.table("storageLayout").toArray(),
    }
    db.close()
    db.use({
      stack: "dbcore",
      name: "FailSessionListWitness",
      level: 1.25,
      create: (down) => ({
        ...down,
        table(name) {
          const table = down.table(name)
          if (name !== "storageLayout") return table
          return {
            ...table,
            mutate(request) {
              if (request.type !== operation) return table.mutate(request)
              return Dexie.Promise.resolve({
                numFailures: 1,
                failures: { 0: new Error(`witness ${operation} unavailable`) },
                lastResult: undefined,
              })
            },
          }
        },
      }),
    })
    await db.open()
    let caught: unknown
    await expect(
      db.transaction("rw", "sessions", async () => {
        const write =
          operation === "put"
            ? db.table("sessions").put(row("a", { title: "Must roll back" }))
            : db.table("sessions").delete("a")
        await Promise.resolve(write).catch((error: unknown) => {
          caught = error
        })
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(caught).toEqual(new Error(`witness ${operation} unavailable`))
    expect(await raw("sessions", "a")).toEqual(before.source)
    expect(await raw("sessionList", "a")).toEqual(before.projection)
    expect(await db.table("storageLayout").toArray()).toEqual(before.witnesses)
  }
)

it.each([undefined, "p1"])(
  "invalidates live scope %s after an old-build title edit with unchanged timestamp and row count",
  async (projectId) => {
    await db.table("sessions").put(row("a"))
    await ensureSessionListReady(db)
    await readVerifiedSessionListRows(db)
    const old = new Dexie(name)
    old.version(1).stores({
      sessions: "id, updatedAt, projectId, [projectId+updatedAt]",
      sessionList: "id, updatedAt, workspaceKey, [workspaceKey+updatedAt]",
      storageLayout: "id",
    })
    old.use(createEncryptedContentMiddleware(name))
    await old.open()
    let resolveInitial!: () => void
    const initial = new Promise<void>((resolve) => {
      resolveInitial = resolve
    })
    let resolveChanged!: () => void
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve
    })
    const errors: unknown[] = []
    const subscription = Dexie.liveQuery(() =>
      readVerifiedSessionListRows(db, projectId)
    ).subscribe({
      next(rows) {
        if (rows?.[0]?.title === "Secret title a") resolveInitial()
        if (rows?.[0]?.title === "Old live title") resolveChanged()
      },
      error(error) {
        errors.push(error)
      },
    })
    try {
      await initial
      await old.table("sessions").update("a", { title: "Old live title" })
      await changed
      expect(errors).toEqual([])
      expect((await old.table("sessions").get("a")).updatedAt).toBe(2)
      expect(await old.table("sessions").count()).toBe(1)
    } finally {
      subscription.unsubscribe()
      old.close()
    }
  }
)

it("initializes a fresh target when its first list is a liveQuery", async () => {
  await db.table("sessions").put(row("fresh-live"))
  let subscription: { unsubscribe(): void } | undefined
  try {
    const rows = await new Promise<unknown>((resolve, reject) => {
      subscription = Dexie.liveQuery(() => readVerifiedSessionListRows(db)).subscribe({
        next: resolve,
        error: reject,
      })
    })
    expect(rows).toEqual([projectSessionListRow(row("fresh-live"))])
  } finally {
    subscription?.unsubscribe()
  }
})

it("reuses authenticated projection payloads while refreshing source witnesses and indexed fields", async () => {
  await db.table("sessions").bulkPut([row("a"), row("b")])
  await ensureSessionListReady(db)
  await readVerifiedSessionListRows(db)
  const decrypt = jest.spyOn(crypto.subtle, "decrypt")
  try {
    const first = await readVerifiedSessionListRows(db)
    expect(decrypt).not.toHaveBeenCalled()
    first![0].title = "Caller mutation"
    expect((await readVerifiedSessionListRows(db))?.[0].title).not.toBe("Caller mutation")

    await db.table("sessions").update("a", { transcriptRevision: 2 })
    decrypt.mockClear()
    expect(await readVerifiedSessionListRows(db)).toHaveLength(2)
    expect(decrypt).not.toHaveBeenCalled()

    await db.table("sessions").update("a", { updatedAt: 10, projectId: "p2" })
    const changed = await readVerifiedSessionListRows(db, "p2")
    expect(changed).toEqual([projectSessionListRow(row("a", { updatedAt: 10, projectId: "p2" }))])
    decrypt.mockClear()
    expect(await readVerifiedSessionListRows(db, "p1")).toEqual([projectSessionListRow(row("b"))])
    expect(decrypt).not.toHaveBeenCalled()
  } finally {
    decrypt.mockRestore()
  }
})

it("cannot reuse an authenticated but rolled-back projection for the committed row", async () => {
  await db.table("sessions").put(row("a"))
  await ensureSessionListReady(db)
  await readVerifiedSessionListRows(db)
  await expect(
    db.transaction("rw", "sessions", "sessionList", async () => {
      await db.table("sessions").update("a", { title: "Uncommitted" })
      expect((await db.table("sessionList").get("a")).title).toBe("Uncommitted")
      throw new Error("rollback cached projection")
    })
  ).rejects.toThrow("rollback cached projection")
  expect((await readVerifiedSessionListRows(db))?.[0].title).toBe("Secret title a")

  await db.table("sessions").delete("a")
  expect(await readVerifiedSessionListRows(db)).toEqual([])
  await db.table("sessions").put(row("a", { title: "Recreated" }))
  expect((await readVerifiedSessionListRows(db))?.[0].title).toBe("Recreated")
  lockAccountContentCipher()
  await expect(readVerifiedSessionListRows(db)).rejects.toThrow(/locked/)
})

it("verifies the global list without transferring unchanged source ciphertext values", async () => {
  await db.table("sessions").bulkPut([row("a"), row("b")])
  await ensureSessionListReady(db)
  const getAll = jest.spyOn(IDBIndex.prototype, "getAll")
  try {
    expect(await readVerifiedSessionListRows(db)).toHaveLength(2)
    const sourceReads = getAll.mock.contexts.filter(
      (index) => index.objectStore.name === "sessions"
    )
    expect(sourceReads).toHaveLength(0)
  } finally {
    getAll.mockRestore()
  }
})
