import { getDb, type CogniaDB } from "./schema"

export interface SharedRunJournal {
  runId: string
  leaseId: string
  token: string
  deviceId: string
  queueItemId?: string
  baselineMessageIds: string[]
  terminalStatus?: "completed" | "failed" | "cancelled"
}

export interface SharedRunJournalRow {
  id: string
  journal?: SharedRunJournal
  send?: SharedSendJournal
}

export interface SharedSendJournal {
  attachmentIds?: string[]
  messageId: string
  parts: unknown[]
  createdAt: number
}

function encryptedDatabase(db: CogniaDB): CogniaDB {
  if (!db.name.startsWith("cognia-account-")) {
    throw new Error("Shared execution recovery requires an encrypted account database")
  }
  return db
}

// Existing message/session tables are portable; lease credentials must remain
// on their issuing device. A separate governed table owns this recovery data.
export async function putSharedRunJournal(
  id: string,
  journal: SharedRunJournal,
  db = getDb()
): Promise<void> {
  await encryptedDatabase(db).sharedRunJournals.put({ id, journal })
}

export async function getSharedRunJournal(
  id: string,
  db = getDb()
): Promise<SharedRunJournal | undefined> {
  return (await encryptedDatabase(db).sharedRunJournals.get(id))?.journal
}

export async function deleteSharedRunJournal(id: string, db = getDb()): Promise<void> {
  await encryptedDatabase(db).sharedRunJournals.delete(id)
}

export async function putSharedSendJournal(
  id: string,
  send: SharedSendJournal,
  db = getDb()
): Promise<void> {
  await encryptedDatabase(db).sharedRunJournals.put({ id: `send:${id}`, send })
}

export async function getSharedSendJournal(
  id: string,
  db = getDb()
): Promise<SharedSendJournal | undefined> {
  return (await encryptedDatabase(db).sharedRunJournals.get(`send:${id}`))?.send
}

export async function deleteSharedSendJournal(id: string, db = getDb()): Promise<void> {
  await encryptedDatabase(db).sharedRunJournals.delete(`send:${id}`)
}
