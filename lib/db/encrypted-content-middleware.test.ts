import "fake-indexeddb/auto"

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
    content: "plaintext must not survive",
    createdAt: new Date(100),
  })

  await expect(db.messages.get("msg_1")).resolves.toMatchObject({
    id: "msg_1",
    sessionId: "session_1",
    role: "user",
    content: "plaintext must not survive",
  })

  const raw = new Dexie(DATABASE_NAME)
  await raw.open()
  const stored = (await raw.table("messages").get("msg_1")) as Record<string, unknown>
  expect(stored.id).toBe("msg_1")
  expect(stored.sessionId).toBe("session_1")
  expect(stored.content).toBeUndefined()
  expect(JSON.stringify(stored)).not.toContain("plaintext must not survive")
  expect(stored.__cogniaEncryptedContent).toBeDefined()
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
    content: "secret",
    createdAt: new Date(100),
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
