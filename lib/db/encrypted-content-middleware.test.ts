import "fake-indexeddb/auto"

import Dexie from "dexie"

import {
  AccountContentCipher,
  __resetAccountContentCipherForTesting,
  activateAccountContentCipher,
} from "@/lib/accounts/content-cipher"
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
