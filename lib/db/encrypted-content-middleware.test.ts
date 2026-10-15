import "fake-indexeddb/auto"
import { spawnSync } from "node:child_process"
import { buildSync } from "esbuild"

import Dexie, {
  type DBCore,
  type DBCoreMutateRequest,
  type DBCorePutRequest,
  type DBCoreTable,
} from "dexie"

import {
  AccountContentCipher,
  __resetAccountContentCipherForTesting,
  activateAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import { createEncryptedContentMiddleware } from "./encrypted-content-middleware"
import { CogniaDB } from "./schema"

const DATABASE_NAME = "cognia-account-acct_crypto"

it("settles concurrent encrypted cursor reads in the native headless runtime", () => {
  // Jest's crypto/Promise environment does not reproduce the Node transaction
  // scope interleaving that stalled scheduler startup after restoring rows.
  const bundle = buildSync({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import "fake-indexeddb/auto";
        import Dexie from "dexie";
        import { AccountContentCipher, activateAccountContentCipher } from "./lib/accounts/content-cipher";
        import { createEncryptedContentMiddleware } from "./lib/db/encrypted-content-middleware";
        Dexie.dependencies.indexedDB = indexedDB;
        Dexie.dependencies.IDBKeyRange = IDBKeyRange;
        const name = "cognia-account-native-cursor";
        activateAccountContentCipher(await AccountContentCipher.createForTesting("native-cursor", name));
        const db = new Dexie(name);
        db.version(1).stores({ messages: "id, sessionId, createdAt" });
        db.use(createEncryptedContentMiddleware(name));
        await db.open();
        await db.table("messages").bulkPut(Array.from({ length: 8 }, (_, index) => ({
          id: String(index), sessionId: "s", createdAt: index,
          content: index % 2 ? "skip" : "keep"
        })));
        const matching = () => db.table("messages").where("sessionId").equals("s")
          .filter(row => row.content === "keep");
        const timer = setTimeout(() => { console.error("cursor reads did not settle"); process.exit(1); }, 3000);
        const result = await Promise.all([
          db.table("messages").toArray().then(rows => rows.length),
          matching().count(),
          matching().sortBy("createdAt").then(rows => rows.map(row => row.id))
        ]);
        clearTimeout(timer);
        db.close();
        console.log(JSON.stringify(result));
      `,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
  })
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: bundle.outputFiles[0].text,
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, NODE_ENV: "test" },
  })
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
  expect(JSON.parse(result.stdout.trim())).toEqual([8, 4, ["0", "2", "4", "6"]])
})

it("filters and sorts encrypted cursor rows without hanging", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  try {
    await db.messages.bulkPut([
      {
        id: "cursor_1",
        sessionId: "cursor",
        role: "user",
        parts: [{ type: "text", text: "keep" }],
        createdAt: 200,
      },
      {
        id: "cursor_2",
        sessionId: "cursor",
        role: "user",
        parts: [{ type: "text", text: "skip" }],
        createdAt: 100,
      },
      {
        id: "cursor_3",
        sessionId: "cursor",
        role: "user",
        parts: [{ type: "text", text: "keep" }],
        createdAt: 300,
      },
    ])
    await expect(
      Promise.all([
        db.messages.toArray().then((rows) => rows.length),
        db.messages
          .where("sessionId")
          .equals("cursor")
          .filter((row) => row.parts.some((part) => part.type === "text" && part.text === "keep"))
          .count(),
        db.messages
          .where("sessionId")
          .equals("cursor")
          .filter((row) => row.parts.some((part) => part.type === "text" && part.text === "keep"))
          .sortBy("createdAt"),
      ])
    ).resolves.toMatchObject([3, 2, [{ id: "cursor_1" }, { id: "cursor_3" }]])
  } finally {
    db.close()
  }
})

it("rejects a throwing encrypted-row filter instead of leaving its query pending", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  try {
    await db.messages.put({
      id: "filter-error",
      sessionId: "filter-error",
      role: "user",
      parts: [{ type: "text", text: "encrypted" }],
      createdAt: 100,
    })
    await expect(
      db.messages
        .filter(() => {
          throw new Error("invalid filter")
        })
        .toArray()
    ).rejects.toThrow("invalid filter")
  } finally {
    db.close()
  }
})

beforeEach(async () => {
  __resetAccountContentCipherForTesting()
  await Dexie.delete(DATABASE_NAME)
})

afterAll(async () => {
  __resetAccountContentCipherForTesting()
  await Dexie.delete(DATABASE_NAME)
})

it("stores message content as ciphertext while preserving indexed metadata", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  await db.messages.put({
    id: "msg_1",
    sessionId: "session_1",
    role: "user",
    parts: [{ type: "text", text: "plaintext must not survive" }],
    createdAt: 100,
  })

  await expect(db.messages.get("msg_1")).resolves.toMatchObject({
    id: "msg_1",
    sessionId: "session_1",
    role: "user",
    parts: [{ type: "text", text: "plaintext must not survive" }],
  })

  const raw = new Dexie(DATABASE_NAME)
  await raw.open()
  const stored = (await raw.table("messages").get("msg_1")) as Record<string, unknown>
  expect(stored.id).toBe("msg_1")
  expect(stored.sessionId).toBe("session_1")
  expect(stored.parts).toBeUndefined()
  expect(JSON.stringify(stored)).not.toContain("plaintext must not survive")
  expect(stored.__cogniaEncryptedContent).toBeDefined()
  raw.close()
  db.close()
})

it("seals Notification V2's payloads, addresses and run summaries (ADR-0190)", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  await db.notificationDeliveryIntents.put({
    id: "intent_1",
    scopeKey: "scope_1",
    operationKey: "op_1",
    targetId: "target_1",
    status: "queued",
    targetAddress: {
      kind: "connector",
      adapterId: "lark",
      deliveryTarget: { chatId: "oc_secret" },
    },
    payload: { title: "Deploy to prod finished", body: "3 tests failed in billing" },
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await db.runResultSummaries.put({
    id: "summary_1",
    scopeKey: "scope_1",
    runId: "run_1",
    revision: 1,
    headline: "Migrated the invoices table",
    digest: "invoices: 41 rows rewritten",
    facts: [],
    createdAt: 1,
  } as never)

  await expect(db.notificationDeliveryIntents.get("intent_1")).resolves.toMatchObject({
    status: "queued",
    payload: { title: "Deploy to prod finished" },
  })
  await expect(
    db.notificationDeliveryIntents.where("status").equals("queued").count()
  ).resolves.toBe(1)

  const raw = new Dexie(DATABASE_NAME)
  await raw.open()
  const intent = (await raw.table("notificationDeliveryIntents").get("intent_1")) as Record<
    string,
    unknown
  >
  // Indexed columns stay queryable; the payload and the address do not.
  expect(intent.status).toBe("queued")
  expect(intent.payload).toBeUndefined()
  expect(JSON.stringify(intent)).not.toContain("3 tests failed")
  expect(JSON.stringify(intent)).not.toContain("oc_secret")
  const summary = (await raw.table("runResultSummaries").get("summary_1")) as Record<
    string,
    unknown
  >
  expect(summary.runId).toBe("run_1")
  expect(JSON.stringify(summary)).not.toContain("invoices")

  // A target written before its table was encrypted still reads, and is
  // sealed by its next write.
  await raw.table("notificationTargets").put({
    id: "target_1",
    scopeKey: "scope_1",
    enabledKey: 1,
    addressFingerprint: "fp_1",
    label: "Release channel",
    updatedAt: 1,
  })
  await expect(db.notificationTargets.get("target_1")).resolves.toMatchObject({
    label: "Release channel",
  })
  await db.notificationTargets.update("target_1", { updatedAt: 2 })
  const sealed = (await raw.table("notificationTargets").get("target_1")) as Record<string, unknown>
  expect(sealed.label).toBeUndefined()
  expect(sealed.__cogniaEncryptedContent).toBeDefined()
  await expect(db.notificationTargets.get("target_1")).resolves.toMatchObject({
    label: "Release channel",
    updatedAt: 2,
  })
  raw.close()
  db.close()
})

it("fails closed when the account key is locked or replaced", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  await db.messages.put({
    id: "msg_1",
    sessionId: "session_1",
    role: "user",
    parts: [{ type: "text", text: "secret" }],
    createdAt: 100,
  })

  __resetAccountContentCipherForTesting()
  await expect(db.messages.get("msg_1")).rejects.toThrow(/locked/i)

  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  await expect(db.messages.get("msg_1")).rejects.toBeDefined()
  db.close()
})

it("treats an empty bulk write and a no-match modify as no-ops", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()

  // The Host dispatch drain claims nothing on a quiet tick and still writes.
  await expect(db.hostDispatchQueue.bulkPut([])).resolves.toBeUndefined()
  await expect(db.messages.bulkAdd([])).resolves.toBeUndefined()
  await expect(
    db.messages.where("sessionId").equals("session_absent").modify({ role: "assistant" })
  ).resolves.toBe(0)

  db.close()
})

it("keeps an update()'s field patch out of storage", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  await db.messages.put({
    id: "msg_1",
    sessionId: "session_1",
    role: "user",
    parts: [{ type: "text", text: "first" }],
    createdAt: 100,
  })
  await db.messages.update("msg_1", {
    parts: [{ type: "text", text: "patched plaintext" }],
  })

  await expect(db.messages.get("msg_1")).resolves.toMatchObject({
    id: "msg_1",
    parts: [{ type: "text", text: "patched plaintext" }],
  })

  const raw = new Dexie(DATABASE_NAME)
  await raw.open()
  const stored = (await raw.table("messages").get("msg_1")) as Record<string, unknown>
  expect(stored.parts).toBeUndefined()
  expect(JSON.stringify(stored)).not.toContain("patched plaintext")
  raw.close()
  db.close()
})

/**
 * The two read-then-write shapes the Host dispatch queue runs on every tick.
 *
 * Both live in `lib/db/host-dispatch-queue.ts`, whose own suite calls `getDb()`
 * and therefore opens `LEGACY_COGNIA_DB_NAME`: the middleware is only installed
 * for a `cognia-account-` database, so that suite never touches an encrypted
 * row and cannot catch anything here.
 *
 * This case covers the shapes end to end. It does NOT prove the transaction
 * keep-alive: `fake-indexeddb` keeps a transaction usable across a native await
 * where a browser would have committed it, so deleting `Dexie.waitFor` leaves
 * this green (verified by mutation). The keep-alive itself is pinned by the
 * next case, which asserts the mechanism rather than an effect the fake backend
 * does not reproduce.
 */
it("survives a read-then-write inside one readwrite transaction", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  await db.messages.bulkPut([
    {
      id: "msg_1",
      sessionId: "session_1",
      role: "user",
      parts: [{ type: "text", text: "one" }],
      createdAt: 100,
    },
    {
      id: "msg_2",
      sessionId: "session_1",
      role: "user",
      parts: [{ type: "text", text: "two" }],
      createdAt: 200,
    },
  ])

  // `markHostDispatchInflight`: one `get`, then a write, same transaction.
  await db.transaction("rw", db.messages, async () => {
    const row = await db.messages.get("msg_1")
    await db.messages.update("msg_1", { role: row?.role === "user" ? "assistant" : "user" })
  })

  // `claimDueHostDispatch`: a range `query`, then write back what it returned.
  await db.transaction("rw", db.messages, async () => {
    const rows = await db.messages.where("sessionId").equals("session_1").toArray()
    await db.messages.bulkPut(rows.map((row) => ({ ...row, createdAt: row.createdAt + 1 })))
  })

  await expect(db.messages.get("msg_1")).resolves.toMatchObject({
    role: "assistant",
    createdAt: 101,
    parts: [{ type: "text", text: "one" }],
  })
  await expect(db.messages.get("msg_2")).resolves.toMatchObject({
    createdAt: 201,
    parts: [{ type: "text", text: "two" }],
  })
  db.close()
})

/**
 * No layer under this one reads `changeSpec` / `updates` today, so a round trip
 * through Dexie proves nothing about them: the assertion would pass with the
 * strip deleted. The only honest pin is the request actually handed downwards,
 * which is what a stub DBCore gives us.
 */
it("never forwards Dexie's field patch to the layer below", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const forwarded: DBCoreMutateRequest[] = []
  const downTable = {
    name: "messages",
    schema: {
      name: "messages",
      primaryKey: {
        name: "",
        keyPath: "id",
        extractKey: (row: { id: string }) => row.id,
        isPrimaryKey: true,
        outbound: false,
        autoIncrement: false,
        unique: true,
        compound: false,
        multiEntry: false,
      },
      indexes: [],
    },
    mutate: async (request: DBCoreMutateRequest) => {
      forwarded.push(request)
      return { numFailures: 0, failures: {}, results: [], lastResult: undefined }
    },
  } as unknown as DBCoreTable
  const core = createEncryptedContentMiddleware(DATABASE_NAME).create({
    table: () => downTable,
  } as unknown as DBCore)

  await core.table!("messages").mutate({
    type: "put",
    trans: {} as never,
    keys: ["msg_1"],
    values: [
      {
        id: "msg_1",
        sessionId: "session_1",
        role: "user",
        parts: [{ type: "text", text: "patched plaintext" }],
        createdAt: 100,
      },
    ],
    criteria: { index: null, range: {} as never },
    changeSpec: { parts: [{ type: "text", text: "patched plaintext" }] },
    updates: { keys: ["msg_1"], changeSpecs: [{ parts: [] }] },
  } as unknown as DBCoreMutateRequest)

  expect(forwarded).toHaveLength(1)
  const request = forwarded[0] as DBCorePutRequest
  expect(request.changeSpec).toBeUndefined()
  expect(request.updates).toBeUndefined()
  // The write *description* is not row data and is deliberately left alone.
  expect(request.criteria).toBeDefined()
  expect(JSON.stringify(request)).not.toContain("patched plaintext")
})

/**
 * The keep-alive, asserted as the mechanism it is.
 *
 * Decryption awaits WebCrypto, a promise Dexie does not own. Inside a
 * transaction, awaiting it directly lets the IndexedDB transaction go inactive
 * and the next write dies with InvalidStateError, which is what took down
 * `markHostDispatchInflight` and `claimDueHostDispatch`. Only a real IndexedDB
 * enforces that lifetime, so the round trip above cannot fail on it and this
 * case watches the call instead.
 *
 * The second half is the other side of the same decision: the wait arms a timer
 * and spins a keep-alive request, so it is skipped when no row carries an
 * envelope and there is nothing to await.
 */
it("routes decryption through Dexie.waitFor, and only when there is ciphertext", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  await db.messages.put({
    id: "msg_1",
    sessionId: "session_1",
    role: "user",
    parts: [{ type: "text", text: "one" }],
    createdAt: 100,
  })

  const waitFor = jest.spyOn(Dexie, "waitFor")
  try {
    waitFor.mockClear()
    await db.messages.get("msg_1")
    expect(waitFor).toHaveBeenCalled()

    waitFor.mockClear()
    await db.messages.where("sessionId").equals("session_1").toArray()
    expect(waitFor).toHaveBeenCalled()

    waitFor.mockClear()
    await db.messages.bulkGet(["msg_1"])
    expect(waitFor).toHaveBeenCalled()

    // Nothing to decrypt: a miss must not pay the timer or the keep-alive spin.
    waitFor.mockClear()
    await expect(db.messages.get("msg_absent")).resolves.toBeUndefined()
    await db.messages.where("sessionId").equals("session_absent").toArray()
    await db.messages.bulkGet(["msg_absent"])
    expect(waitFor).not.toHaveBeenCalled()
  } finally {
    waitFor.mockRestore()
    db.close()
  }
})

describe("synchronous session list cache hits", () => {
  async function fixture() {
    const cipher = await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
    activateAccountContentCipher(cipher)
    const db = new Dexie(DATABASE_NAME)
    db.version(1).stores({ sessionList: "id, updatedAt" })
    db.use(createEncryptedContentMiddleware(DATABASE_NAME))
    await db.open()
    const projection = db.table("sessionList")
    await projection.bulkPut([
      { id: "a", updatedAt: 1, title: "cached", nested: { bytes: new Uint8Array([1, 2]) } },
      { id: "b", updatedAt: 2, title: "cold" },
    ])
    const raw = new Dexie(DATABASE_NAME)
    await raw.open()
    await raw.table("sessionList").put({ id: "legacy", updatedAt: 3, title: "plaintext legacy" })
    return { cipher, db, raw, projection }
  }

  it("skips async decrypt wrappers and transaction holds for cached and plaintext reads", async () => {
    const { cipher, db, raw, projection } = await fixture()
    try {
      await projection.toArray()
      await raw.table("sessionList").update("a", { updatedAt: 99 })
      const waitFor = jest.spyOn(Dexie, "waitFor")
      const decrypt = jest.spyOn(cipher, "decrypt")
      try {
        const row = await projection.get("a")
        expect(row.updatedAt).toBe(99)
        row.nested.bytes[0] = 99
        expect(await projection.bulkGet(["legacy", "b", "missing", "a"])).toMatchObject([
          { id: "legacy", title: "plaintext legacy" },
          { id: "b", title: "cold" },
          undefined,
          { id: "a", updatedAt: 99, nested: { bytes: new Uint8Array([1, 2]) } },
        ])
        expect(await projection.toArray()).toHaveLength(3)
        expect(decrypt).not.toHaveBeenCalled()
        expect(waitFor).not.toHaveBeenCalled()
      } finally {
        decrypt.mockRestore()
        waitFor.mockRestore()
      }
    } finally {
      raw.close()
      db.close()
    }
  })

  it("holds one mixed cache-miss read through crypto before the following transaction write", async () => {
    const { cipher, db, raw, projection } = await fixture()
    try {
      await projection.get("a")
      const waitFor = jest.spyOn(Dexie, "waitFor")
      const decrypt = jest.spyOn(cipher, "decrypt")
      try {
        await withSpecTransactionActivity(() =>
          db.transaction("rw", projection, async () => {
            expect(await projection.bulkGet(["legacy", "a", "missing", "b"])).toMatchObject([
              { id: "legacy", title: "plaintext legacy" },
              { id: "a", title: "cached" },
              undefined,
              { id: "b", title: "cold" },
            ])
            expect(decrypt).toHaveBeenCalledTimes(1)
            expect(waitFor).toHaveBeenCalledTimes(1)
            await projection.put({ id: "written", updatedAt: 4, title: "after mixed read" })
          })
        )
        expect(await projection.get("written")).toMatchObject({ title: "after mixed read" })
      } finally {
        decrypt.mockRestore()
        waitFor.mockRestore()
      }
    } finally {
      raw.close()
      db.close()
    }
  })

  it("rejects corrupted envelopes and locked reads after the projection cache is warm", async () => {
    const { cipher, db, raw, projection } = await fixture()
    try {
      await projection.get("a")
      const stored = await raw.table("sessionList").get("a")
      const ciphertext = stored.__cogniaEncryptedContent.ciphertext as string
      stored.__cogniaEncryptedContent.ciphertext =
        (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1)
      await raw.table("sessionList").put(stored)
      await expect(projection.get("a")).rejects.toBeDefined()
      cipher.lock()
      await expect(projection.bulkGet(["legacy", "a"])).rejects.toThrow(/locked/)
      await expect(projection.toArray()).rejects.toThrow(/locked/)
    } finally {
      raw.close()
      db.close()
    }
  })

  async function denseFixture() {
    const prepared = await fixture()
    const ids = Array.from({ length: 128 }, (_, index) => `dense-${String(index).padStart(3, "0")}`)
    await prepared.projection.bulkPut(
      ids.map((id, index) => ({ id, updatedAt: index, title: `Private ${id}` }))
    )
    await prepared.raw
      .table("sessionList")
      .update("legacy", { nested: { bytes: new Uint8Array([1, 2]) } })
    await prepared.projection.toArray()
    return { ...prepared, ids }
  }

  it("batches dense requested IDs in two native requests without decrypting corrupt orphan rows", async () => {
    const { cipher, db, raw, projection, ids } = await denseFixture()
    try {
      const orphan = { ...(await raw.table("sessionList").get("a")), id: "orphan" }
      await raw.table("sessionList").put(orphan)
      const keys = ["missing", ...ids.toReversed(), "legacy"]
      const get = jest.spyOn(IDBObjectStore.prototype, "get")
      const getAll = jest.spyOn(IDBObjectStore.prototype, "getAll")
      const count = jest.spyOn(IDBObjectStore.prototype, "count")
      const decrypt = jest.spyOn(cipher, "decrypt")
      try {
        const result = await db.transaction("r", projection, () => projection.bulkGet(keys))
        expect(result.map((row) => row?.id)).toEqual([undefined, ...ids.toReversed(), "legacy"])
        expect(result[1]).toMatchObject({ title: `Private ${ids[127]}` })
        expect(get).not.toHaveBeenCalled()
        expect(count).toHaveBeenCalledTimes(1)
        expect(getAll).toHaveBeenCalledTimes(1)
        expect(decrypt).not.toHaveBeenCalled()
      } finally {
        get.mockRestore()
        getAll.mockRestore()
        count.mockRestore()
        decrypt.mockRestore()
      }
      await expect(
        db.transaction("r", projection, () => projection.bulkGet([...ids, "orphan"]))
      ).rejects.toBeDefined()
    } finally {
      raw.close()
      db.close()
    }
  })

  it("keeps duplicate and separate plaintext results independently owned", async () => {
    const { db, raw, projection, ids } = await denseFixture()
    try {
      const keys = ["legacy", "legacy", ...ids]
      const getAll = jest.spyOn(IDBObjectStore.prototype, "getAll")
      const count = jest.spyOn(IDBObjectStore.prototype, "count")
      try {
        const result = await db.transaction("r", projection, () => projection.bulkGet(keys))
        result[0].nested.bytes[0] = 99
        expect(result[1].nested.bytes).toEqual(new Uint8Array([1, 2]))
        expect(getAll).not.toHaveBeenCalled()
        expect(count).not.toHaveBeenCalled()
      } finally {
        getAll.mockRestore()
        count.mockRestore()
      }
      const first = await db.transaction("r", projection, () =>
        projection.bulkGet(["legacy", ...ids])
      )
      first[0].nested.bytes[0] = 99
      const second = await db.transaction("r", projection, () =>
        projection.bulkGet(["legacy", ...ids])
      )
      expect(second[0].nested.bytes).toEqual(new Uint8Array([1, 2]))
    } finally {
      raw.close()
      db.close()
    }
  })

  it("keeps a dense cold encrypted batch alive through a following transaction write", async () => {
    const { db, raw, projection, ids } = await denseFixture()
    try {
      await projection.bulkPut(
        ids.map((id, index) => ({ id, updatedAt: index, title: `Changed ${id}` }))
      )
      const waitFor = jest.spyOn(Dexie, "waitFor")
      try {
        await withSpecTransactionActivity(() =>
          db.transaction("rw", projection, async () => {
            const result = await projection.bulkGet([...ids, "legacy", "missing"])
            expect(result[0]).toMatchObject({ title: `Changed ${ids[0]}` })
            expect(result[ids.length]).toMatchObject({ title: "plaintext legacy" })
            expect(result[ids.length + 1]).toBeUndefined()
            expect(waitFor).toHaveBeenCalledTimes(1)
            await projection.put({ id: "after-dense", updatedAt: 5, title: "committed" })
          })
        )
      } finally {
        waitFor.mockRestore()
      }
      expect(await projection.get("after-dense")).toMatchObject({ title: "committed" })
    } finally {
      raw.close()
      db.close()
    }
  })

  it("falls back to per-key reads for sparse, small, implicit, or transaction-cache requests", async () => {
    const { db, raw, projection, ids } = await denseFixture()
    try {
      await raw.table("sessionList").bulkPut(
        Array.from({ length: 400 }, (_, index) => ({
          id: `outside-${index}`,
          updatedAt: index,
          title: "unrequested legacy row",
        }))
      )
      const get = jest.spyOn(IDBObjectStore.prototype, "get")
      const getAll = jest.spyOn(IDBObjectStore.prototype, "getAll")
      const count = jest.spyOn(IDBObjectStore.prototype, "count")
      try {
        await db.transaction("r", projection, () => projection.bulkGet(ids))
        expect(count).toHaveBeenCalledTimes(1)
        expect(getAll).not.toHaveBeenCalled()
        expect(get).toHaveBeenCalledTimes(ids.length)
        count.mockClear()
        get.mockClear()
        await db.transaction("r", projection, () => projection.bulkGet(ids.slice(0, 2)))
        await projection.bulkGet(ids)
        await db.transaction("r", projection, () =>
          projection.core.getMany({
            trans: Dexie.currentTransaction!.idbtrans,
            keys: ids,
            cache: "clone",
          })
        )
        expect(count).not.toHaveBeenCalled()
        expect(getAll).not.toHaveBeenCalled()
        expect(get).toHaveBeenCalledTimes(ids.length * 2 + 2)
      } finally {
        get.mockRestore()
        getAll.mockRestore()
        count.mockRestore()
      }
    } finally {
      raw.close()
      db.close()
    }
  })
})

/**
 * The crash this guards is real and was reachable from ordinary UI work: a
 * `waitFor` established on a transaction that has already committed throws
 * `InvalidStateError: … The transaction has finished` synchronously, out of the
 * middleware, and the read that had already succeeded fails with it.
 *
 * The rows are in hand by then — decrypting them needs no transaction — so the
 * only correct answer is to finish the read. Anything the CALLER still wants to
 * do in that transaction is beyond saving either way, and Dexie reports that
 * itself, by its right name.
 */
it("finishes the read when the transaction can no longer be held open", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  await db.messages.put({
    id: "msg_1",
    sessionId: "session_1",
    role: "user",
    parts: [{ type: "text", text: "one" }],
    createdAt: 100,
  })

  const waitFor = jest.spyOn(Dexie, "waitFor").mockImplementation(() => {
    throw new DOMException(
      "Failed to execute 'objectStore' on 'IDBTransaction': The transaction has finished.",
      "InvalidStateError"
    )
  })
  try {
    await expect(db.messages.get("msg_1")).resolves.toMatchObject({
      parts: [{ type: "text", text: "one" }],
    })
    await expect(
      db.messages.where("sessionId").equals("session_1").toArray()
    ).resolves.toMatchObject([{ parts: [{ type: "text", text: "one" }] }])
    await expect(db.messages.bulkGet(["msg_1"])).resolves.toMatchObject([
      { parts: [{ type: "text", text: "one" }] },
    ])
    // The cursor path is the one that cannot finish without the hold, so it
    // fails by name instead of falling back. Iteration issues another request
    // per row, and on a transaction that has already committed `continue()`
    // throws from inside the cursor callback, where nothing is left to settle
    // `each()`. Resuming there hung the caller for its full timeout. Failing
    // reports the same finished transaction the other paths quietly survive.
    await expect(
      db.messages
        .where("sessionId")
        .equals("session_1")
        .each(() => {})
    ).rejects.toThrow(/transaction has finished/i)
    // And the write path, which holds across the ENCRYPT instead. This one has
    // a second job: the ciphertext must still be what lands, never the
    // plaintext row the hold was supposed to protect.
    await db.messages.put({
      id: "msg_2",
      sessionId: "session_1",
      role: "user",
      parts: [{ type: "text", text: "two" }],
      createdAt: 200,
    })
    expect(waitFor).toHaveBeenCalled()
  } finally {
    waitFor.mockRestore()
  }
  await expect(db.messages.get("msg_2")).resolves.toMatchObject({
    parts: [{ type: "text", text: "two" }],
  })
  const raw = new Dexie(DATABASE_NAME)
  await raw.open()
  const stored = (await raw.table("messages").get("msg_2")) as Record<string, unknown>
  expect(stored.parts).toBeUndefined()
  expect(stored.__cogniaEncryptedContent).toBeDefined()
  raw.close()
  db.close()
})

/**
 * fake-indexeddb never deactivates a transaction between tasks, so on its own
 * it cannot show the failure a real engine (the Android WebView, Chrome) hits:
 * a request issued from a task that is not one of the transaction's own event
 * dispatches throws `TransactionInactiveError`. This makes it behave to spec
 * for the duration of a callback: after each dispatched request, once the
 * current task and its microtasks are done, the transaction goes inactive
 * again until its next request event.
 */
async function withSpecTransactionActivity<T>(run: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const FDBTransaction = require("fake-indexeddb/lib/FDBTransaction") as {
    prototype: { _start(this: { _state: string }): void }
  }
  const proto = FDBTransaction.prototype
  const original = proto._start
  proto._start = function (this: { _state: string }) {
    original.call(this)
    setImmediate(() => {
      if (this._state === "active") this._state = "inactive"
    })
  }
  try {
    return await run()
  } finally {
    proto._start = original
  }
}

it("iterates encrypted rows by cursor on a transaction that deactivates between tasks", async () => {
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("acct_crypto", DATABASE_NAME)
  )
  const db = new CogniaDB(DATABASE_NAME, "encrypted-content-test")
  await db.open()
  try {
    await db.messages.bulkPut(
      ["a", "b", "c"].map((suffix, index) => ({
        id: `inactive_${suffix}`,
        sessionId: index < 2 ? "inactive_keep" : "inactive_other",
        role: "user" as const,
        parts: [{ type: "text" as const, text: `row ${suffix}` }],
        createdAt: 100 + index,
      }))
    )

    await withSpecTransactionActivity(async () => {
      // `anyOf` walks a cursor (it is an algorithm, not a plain range): the
      // shape of the session-delete cascade's `where("id").anyOf(...)` read,
      // followed by writes in the same readwrite transaction.
      const read = await db.transaction("rw", db.messages, async () => {
        const rows = await db.messages.where("id").anyOf(["inactive_a", "inactive_c"]).toArray()
        await db.messages.where("sessionId").equals("inactive_other").delete()
        return rows
      })
      expect(read.map((row) => row.parts)).toEqual([
        [{ type: "text", text: "row a" }],
        [{ type: "text", text: "row c" }],
      ])

      // `each()` and a filtered read outside any explicit transaction.
      const seen: string[] = []
      await db.messages.each((row) => {
        seen.push(row.id)
      })
      expect(seen.sort()).toEqual(["inactive_a", "inactive_b"])
      await expect(
        db.messages
          .where("sessionId")
          .equals("inactive_keep")
          .filter((row) => row.parts.some((part) => part.type === "text" && part.text === "row b"))
          .toArray()
      ).resolves.toMatchObject([{ id: "inactive_b" }])
    })
  } finally {
    db.close()
  }
})
