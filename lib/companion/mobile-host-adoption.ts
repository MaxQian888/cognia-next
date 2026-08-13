"use client"

import Dexie, { type Table } from "dexie"

import { accountDatabaseName } from "@/lib/accounts/account-db"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { CogniaDB, LEGACY_COGNIA_DB_NAME } from "@/lib/db/schema"
import { migrateAccountDatabaseToTarget } from "@/lib/runtime/target-database-migration"
import { runtimeTargetDatabaseName } from "@/lib/runtime/target-registry"
import {
  companionCredentialBook,
  DEFAULT_ACCOUNT_NAMESPACE,
  hostKeyOf,
  type CompanionCredentialBook,
  type CompanionHostRecord,
} from "./credential-book"

export const MOBILE_HOST_ADOPTION_JOURNAL_DB = "cognia-mobile-host-adoption-journal"
export type MobileHostAdoptionStage =
  "copying-credentials" | "credentials-verified" | "database-verified" | "completed"

interface MobileHostAdoptionJournalEntry {
  id: "mobile-host-adoption-v1"
  stage: MobileHostAdoptionStage
  activeHostId?: string
  updatedAt: number
}

class MobileHostAdoptionJournalDb extends Dexie {
  entries!: Table<MobileHostAdoptionJournalEntry, string>

  constructor() {
    super(MOBILE_HOST_ADOPTION_JOURNAL_DB)
    this.version(1).stores({ entries: "&id, stage, updatedAt" })
  }
}

export class MobileHostAdoptionJournal {
  private readonly db = new MobileHostAdoptionJournalDb()
  get(): Promise<MobileHostAdoptionJournalEntry | undefined> {
    return this.db.entries.get("mobile-host-adoption-v1")
  }
  put(entry: Omit<MobileHostAdoptionJournalEntry, "id" | "updatedAt">): Promise<string> {
    return this.db.entries.put({ id: "mobile-host-adoption-v1", updatedAt: Date.now(), ...entry })
  }
  close(): void {
    this.db.close()
  }
}

interface AdoptionJournalPort {
  get(): Promise<{ stage: string; activeHostId?: string } | undefined>
  put(entry: { stage: MobileHostAdoptionStage; activeHostId?: string }): Promise<unknown>
  close?(): void
}

export interface MobileHostAdoptionDependencies {
  book: CompanionCredentialBook
  journal: AdoptionJournalPort
  migrateDatabase(hostId: string): Promise<void>
  rescopeQueue(hostId: string): Promise<number>
}

/** Journaled, retry-safe adoption from the pre-account Mobile namespace. */
export async function adoptMobileCompanionHosts(
  dependencies?: MobileHostAdoptionDependencies
): Promise<void> {
  const journal = dependencies?.journal ?? new MobileHostAdoptionJournal()
  const deps = dependencies ?? productionDependencies(journal)
  try {
    const existingJournal = await journal.get()
    if (existingJournal?.stage === "completed") return

    const sourceRecords = await deps.book.list(DEFAULT_ACCOUNT_NAMESPACE)
    const sourceActive = await deps.book.getActive(DEFAULT_ACCOUNT_NAMESPACE)
    const activeHostId = existingJournal?.activeHostId ?? sourceActive?.hostId
    if (!activeHostId && sourceRecords.length === 0) {
      await journal.put({ stage: "completed" })
      return
    }

    await journal.put({ stage: "copying-credentials", activeHostId })
    for (const source of sourceRecords) await copyAndVerifyRecord(deps.book, source)
    await journal.put({ stage: "credentials-verified", activeHostId })

    if (activeHostId) {
      const destination = await deps.book.get({
        accountNamespace: DEFAULT_LOCAL_ACCOUNT_ID,
        hostId: activeHostId,
      })
      if (!destination)
        throw new Error("Active Mobile Host was not copied into the account namespace.")
      await deps.book.setActive(hostKeyOf(destination))
      await deps.migrateDatabase(activeHostId)
      await deps.rescopeQueue(activeHostId)
    }
    await journal.put({ stage: "database-verified", activeHostId })

    // Deletion is last. A crash at any prior stage leaves the source pairing
    // and secret intact, and retrying the copy is an idempotent upsert.
    for (const source of sourceRecords) await deps.book.remove(hostKeyOf(source))
    await journal.put({ stage: "completed", activeHostId })
  } finally {
    if (!dependencies) journal.close?.()
  }
}

async function copyAndVerifyRecord(
  book: CompanionCredentialBook,
  source: CompanionHostRecord
): Promise<void> {
  const sourceKey = hostKeyOf(source)
  const credential = await book.loadCredential(sourceKey)
  if (!credential) throw new Error(`Legacy Mobile Host ${source.hostId} has no credential.`)
  const destinationKey = {
    accountNamespace: DEFAULT_LOCAL_ACCOUNT_ID,
    hostId: source.hostId,
  }
  await book.saveCredential(destinationKey, credential)
  await book.upsert({
    ...source,
    accountNamespace: DEFAULT_LOCAL_ACCOUNT_ID,
  })
  const [verifiedRecord, verifiedCredential] = await Promise.all([
    book.get(destinationKey),
    book.loadCredential(destinationKey),
  ])
  if (!verifiedRecord || JSON.stringify(verifiedCredential) !== JSON.stringify(credential)) {
    throw new Error(`Mobile Host ${source.hostId} adoption verification failed.`)
  }
}

function productionDependencies(journal: AdoptionJournalPort): MobileHostAdoptionDependencies {
  return {
    book: companionCredentialBook(),
    journal,
    migrateDatabase: async (hostId) => {
      const targetDbName = runtimeTargetDatabaseName(DEFAULT_LOCAL_ACCOUNT_ID, hostId)
      // Old global Mobile data is oldest; account-scoped data wins on key
      // collisions because it is copied second.
      for (const sourceDbName of [
        LEGACY_COGNIA_DB_NAME,
        accountDatabaseName(DEFAULT_LOCAL_ACCOUNT_ID),
      ]) {
        await migrateAccountDatabaseToTarget({
          accountId: DEFAULT_LOCAL_ACCOUNT_ID,
          targetId: hostId,
          sourceDbName,
          targetDbName,
        })
      }
    },
    rescopeQueue: (hostId) => rescopeLegacyMobileQueue(hostId),
  }
}

async function rescopeLegacyMobileQueue(hostId: string): Promise<number> {
  const db = new CogniaDB(
    runtimeTargetDatabaseName(DEFAULT_LOCAL_ACCOUNT_ID, hostId),
    "mobile-host-adoption"
  )
  try {
    await db.open()
    const rows = await db.mobileOutboundQueue
      .filter(
        (row) =>
          row.targetId === "mobile-companion" ||
          (!row.targetId && row.accountId === DEFAULT_LOCAL_ACCOUNT_ID)
      )
      .toArray()
    if (rows.length > 0) {
      await db.mobileOutboundQueue.bulkPut(
        rows.map((row) => ({ ...row, accountId: DEFAULT_LOCAL_ACCOUNT_ID, targetId: hostId }))
      )
    }
    return rows.length
  } finally {
    db.close()
  }
}
