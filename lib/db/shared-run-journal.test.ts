import "fake-indexeddb/auto"
import Dexie from "dexie"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  __resetAccountContentCipherForTesting,
} from "@/lib/accounts/content-cipher"
import { CogniaDB } from "./schema"
import {
  getSharedRunJournal,
  putSharedRunJournal,
  deleteSharedRunJournal,
  getSharedSendJournal,
  putSharedSendJournal,
  deleteSharedSendJournal,
  type SharedRunJournal,
} from "./shared-run-journal"

const name = "cognia-account-shared-journal-test"
const journal: SharedRunJournal = {
  runId: "run",
  leaseId: "lease",
  token: "never-plaintext-lease-token",
  deviceId: "device",
  baselineMessageIds: ["message"],
  terminalStatus: "completed",
}
let db: CogniaDB

beforeEach(async () => {
  await Dexie.delete(name)
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("shared-journal-test", name)
  )
  db = new CogniaDB(name)
  await db.open()
})
afterEach(async () => {
  db.close()
  await Dexie.delete(name)
  __resetAccountContentCipherForTesting()
})

it("recovers terminal proof across reopen without storing a plaintext token", async () => {
  await putSharedRunJournal("endpoint/org/session", journal, db)
  db.close()
  await db.open()
  expect(await getSharedRunJournal("endpoint/org/session", db)).toEqual(journal)
  const raw = new Dexie(name)
  await raw.open()
  try {
    const row = await raw.table("sharedRunJournals").get("endpoint/org/session")
    expect(row.__cogniaEncryptedContent).toBeDefined()
    expect(JSON.stringify(row)).not.toContain(journal.token)
  } finally {
    raw.close()
  }
  await deleteSharedRunJournal("endpoint/org/session", db)
  expect(await getSharedRunJournal("endpoint/org/session", db)).toBeUndefined()
})

it("refuses a legacy unencrypted database and a locked account", async () => {
  const legacy = new CogniaDB("unencrypted-journal-test")
  await expect(putSharedRunJournal("key", journal, legacy)).rejects.toThrow("encrypted account")
  legacy.close()
  __resetAccountContentCipherForTesting()
  await expect(putSharedRunJournal("key", journal, db)).rejects.toThrow("locked")
})

it("keeps unrelated execution journals when one run completes", async () => {
  await putSharedRunJournal("first", journal, db)
  await putSharedRunJournal("second", { ...journal, runId: "second" }, db)
  await deleteSharedRunJournal("first", db)
  expect((await getSharedRunJournal("second", db))?.runId).toBe("second")
})

it("preserves a failed send identity across restart without mixing it with run recovery", async () => {
  const send = {
    messageId: "stable-id",
    parts: [{ type: "text", text: "private draft" }],
    createdAt: 1,
  }
  await putSharedSendJournal("same", send, db)
  await putSharedRunJournal("same", journal, db)
  db.close()
  await db.open()
  expect(await getSharedSendJournal("same", db)).toEqual(send)
  await deleteSharedSendJournal("same", db)
  expect(await getSharedSendJournal("same", db)).toBeUndefined()
  expect(await getSharedRunJournal("same", db)).toEqual(journal)
})
