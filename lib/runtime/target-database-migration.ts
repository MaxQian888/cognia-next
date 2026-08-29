import Dexie, { type Table } from "dexie"

import { accountDatabaseName } from "@/lib/accounts/account-db"
import { CogniaDB } from "@/lib/db/schema"
import { encryptedRuntimeTargetDatabaseName } from "./target-registry"

export const TARGET_MIGRATION_JOURNAL_DB_NAME = "cognia-runtime-target-migration-journal"
export const DEFAULT_TARGET_MIGRATION_BATCH_SIZE = 500

export type TargetMigrationStage = "copying" | "verified" | "completed" | "failed"

export interface TargetMigrationTableSummary {
  name: string
  sourceCount: number
  verifiedCount: number
}

export interface TargetMigrationJournalRecord {
  accountId: string
  targetId: string
  sourceDbName: string
  targetDbName: string
  stage: TargetMigrationStage
  tables: TargetMigrationTableSummary[]
  updatedAt: number
  error?: string
}

class TargetMigrationJournalDB extends Dexie {
  journals!: Dexie.Table<TargetMigrationJournalRecord, [string, string]>

  constructor(name = TARGET_MIGRATION_JOURNAL_DB_NAME) {
    super(name)
    this.version(1).stores({
      journals: "&[accountId+targetId], accountId, stage, updatedAt",
    })
  }
}

export class TargetDatabaseMigrationJournal {
  constructor(private readonly db = new TargetMigrationJournalDB()) {}

  get(accountId: string, targetId: string): Promise<TargetMigrationJournalRecord | undefined> {
    return this.db.journals.get([accountId, targetId])
  }

  put(record: TargetMigrationJournalRecord): Promise<[string, string]> {
    return this.db.journals.put(record)
  }

  close(): void {
    this.db.close()
  }
}

export interface MigrateAccountDatabaseToTargetInput {
  accountId: string
  targetId: string
  sourceDbName?: string
  targetDbName?: string
  batchSize?: number
  now?: number
  journal?: TargetDatabaseMigrationJournal
}

export interface TargetDatabaseMigrationResult {
  stage: "verified"
  sourceDbName: string
  targetDbName: string
  tables: TargetMigrationTableSummary[]
}

/**
 * Copy an account database into one target database without changing either
 * account or target activation pointers. Every source primary key must be
 * present in the target before the journal reaches `verified`.
 */
export async function migrateAccountDatabaseToTarget(
  input: MigrateAccountDatabaseToTargetInput
): Promise<TargetDatabaseMigrationResult> {
  const sourceDbName = input.sourceDbName ?? accountDatabaseName(input.accountId)
  const targetDbName =
    input.targetDbName ?? encryptedRuntimeTargetDatabaseName(input.accountId, input.targetId)
  const now = input.now ?? Date.now()
  const journal = input.journal ?? new TargetDatabaseMigrationJournal()
  const ownsJournal = input.journal === undefined

  const baseRecord: TargetMigrationJournalRecord = {
    accountId: input.accountId,
    targetId: input.targetId,
    sourceDbName,
    targetDbName,
    stage: "copying",
    tables: [],
    updatedAt: now,
  }

  try {
    await journal.put(baseRecord)
    const batchSize = normalizeBatchSize(input.batchSize)
    if (sourceDbName === targetDbName) {
      throw new Error("Runtime target migration source and destination must differ.")
    }

    if (!(await Dexie.exists(sourceDbName))) {
      const result: TargetDatabaseMigrationResult = {
        stage: "verified",
        sourceDbName,
        targetDbName,
        tables: [],
      }
      await journal.put({ ...baseRecord, ...result, updatedAt: now })
      return result
    }

    // Schema-discovery mode intentionally bypasses the account middleware: an
    // old database is plaintext by definition and must remain readable only by
    // this locked migration path. The destination is a CogniaDB and therefore
    // encrypts every classified payload before persistence.
    const source = new Dexie(sourceDbName)
    const target = new CogniaDB(targetDbName, "target-migration:target")
    try {
      await source.open()
      await target.open()
      const targetTables = new Set(target.tables.map((table) => table.name))
      const tables: TargetMigrationTableSummary[] = []
      const existingProgress = await target.accountContentMigrations.get("singleton")
      const completedTables =
        existingProgress?.accountId === input.accountId &&
        ["migrating", "failed", "verified"].includes(existingProgress.status)
          ? [...existingProgress.completedTables]
          : []
      await target.accountContentMigrations.put({
        id: "singleton",
        accountId: input.accountId,
        status: "migrating",
        completedTables,
        updatedAt: now,
      })

      for (const sourceTable of source.tables) {
        if (sourceTable.name === "accountContentMigrations") continue
        if (!targetTables.has(sourceTable.name)) {
          if ((await sourceTable.count()) > 0) {
            throw new Error(
              `Account content migration cannot copy unknown table ${sourceTable.name}.`
            )
          }
          continue
        }
        const targetTable = target.table(sourceTable.name)
        if (completedTables.includes(sourceTable.name)) {
          const sourceCount = await sourceTable.count()
          const verifiedCount = await verifyRows(sourceTable, targetTable, batchSize)
          tables.push({ name: sourceTable.name, sourceCount, verifiedCount })
          continue
        }
        const sourceCount = await copyRows(sourceTable, targetTable, batchSize)
        const verifiedCount = await verifyRows(sourceTable, targetTable, batchSize)
        tables.push({ name: sourceTable.name, sourceCount, verifiedCount })
        completedTables.push(sourceTable.name)
        await target.accountContentMigrations.put({
          id: "singleton",
          accountId: input.accountId,
          status: "migrating",
          completedTables: [...completedTables],
          updatedAt: Date.now(),
        })
      }

      await target.accountContentMigrations.put({
        id: "singleton",
        accountId: input.accountId,
        status: "verified",
        completedTables,
        updatedAt: Date.now(),
      })

      const result: TargetDatabaseMigrationResult = {
        stage: "verified",
        sourceDbName,
        targetDbName,
        tables,
      }
      await journal.put({ ...baseRecord, ...result, updatedAt: now })
      return result
    } finally {
      source.close()
      target.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await journal.put({
      ...baseRecord,
      stage: "failed",
      error: message,
      updatedAt: Date.now(),
    })
    throw error
  } finally {
    if (ownsJournal) journal.close()
  }
}

export async function markTargetDatabaseMigrationCompleted(
  accountId: string,
  targetId: string,
  now = Date.now(),
  journal = new TargetDatabaseMigrationJournal()
): Promise<void> {
  try {
    const existing = await journal.get(accountId, targetId)
    if (!existing || existing.stage !== "verified") {
      throw new Error("Runtime target migration cannot complete before verification.")
    }
    await journal.put({
      ...existing,
      stage: "completed",
      updatedAt: now,
      error: undefined,
    })
  } finally {
    journal.close()
  }
}

function normalizeBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return DEFAULT_TARGET_MIGRATION_BATCH_SIZE
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("Runtime target migration batch size must be a positive integer.")
  }
  return batchSize
}

async function copyRows(source: Table, target: Table, batchSize: number): Promise<number> {
  let offset = 0
  while (true) {
    const rows = await source.offset(offset).limit(batchSize).toArray()
    if (rows.length === 0) return offset
    await target.bulkPut(rows)
    offset += rows.length
  }
}

async function verifyRows(source: Table, target: Table, batchSize: number): Promise<number> {
  let offset = 0
  while (true) {
    const keys = await source.offset(offset).limit(batchSize).primaryKeys()
    if (keys.length === 0) return offset
    const rows = await target.bulkGet(keys)
    const missingIndex = rows.findIndex((row) => row === undefined)
    if (missingIndex >= 0) {
      throw new Error(
        `Runtime target migration verification failed for table ${source.name}; missing primary key ${String(keys[missingIndex])}.`
      )
    }
    offset += keys.length
  }
}
