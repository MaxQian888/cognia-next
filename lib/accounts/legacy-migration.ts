import Dexie from "dexie"

import { CogniaDB, LEGACY_COGNIA_DB_NAME } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { LEGACY_MIXED_TARGET_ID } from "@/lib/runtime/target-registry"
import { encryptedAccountDatabaseName, type LocalAccountRegistry } from "./account-db"

export const DEFAULT_LEGACY_MIGRATION_BATCH_SIZE = 500
const RETIRED_LEGACY_TABLES = new Set(["syncCursors"])

export interface LegacyMigrationTableSummary {
  name: string
  copied: number
  verified: number
}

export interface LegacyMigrationResult {
  sourceDbName: string
  targetAccountId: string
  targetDbName: string
  tables: LegacyMigrationTableSummary[]
}

export interface MigrateLegacyDatabaseToAccountInput {
  registry: LocalAccountRegistry
  targetAccountId: string
  sourceDbName?: string
  completedAt?: number
  batchSize?: number
}

export async function legacyDatabaseExists(sourceDbName = LEGACY_COGNIA_DB_NAME): Promise<boolean> {
  return Dexie.exists(sourceDbName)
}

export async function migrateLegacyDatabaseToAccount(
  input: MigrateLegacyDatabaseToAccountInput
): Promise<LegacyMigrationResult> {
  const sourceDbName = input.sourceDbName ?? LEGACY_COGNIA_DB_NAME
  const targetDbName = encryptedAccountDatabaseName(input.targetAccountId)
  const batchSize = normalizeBatchSize(input.batchSize)
  const completedAt = input.completedAt ?? Date.now()

  await assertRegistryAccountExists(input.registry, input.targetAccountId)
  if (!(await Dexie.exists(sourceDbName))) {
    throw new Error(`Legacy database ${sourceDbName} does not exist.`)
  }

  // Open the legacy database in Dexie's schema-discovery mode. Constructing a
  // CogniaDB here would upgrade and mutate the source before it is copied,
  // adding every modern empty table and making old-database migration much
  // slower than the data being migrated warrants.
  const source = new Dexie(sourceDbName)
  const target = new CogniaDB(targetDbName, "legacy-migration:target")

  try {
    await source.open()
    await target.open()

    const sourceTableCounts = await Promise.all(
      source.tables.map(async (sourceTable) => ({
        sourceTable,
        rowCount: await sourceTable.count(),
      }))
    )
    const targetTableNames = new Set(target.tables.map((table) => table.name))
    const tables: LegacyMigrationTableSummary[] = []
    for (const { sourceTable, rowCount } of sourceTableCounts) {
      if (rowCount === 0) {
        tables.push({ name: sourceTable.name, copied: 0, verified: 0 })
        continue
      }
      if (!targetTableNames.has(sourceTable.name)) {
        if (!RETIRED_LEGACY_TABLES.has(sourceTable.name)) {
          throw new Error(
            `Legacy migration cannot copy unknown table ${sourceTable.name}; target schema has no matching table.`
          )
        }
        tables.push({ name: sourceTable.name, copied: 0, verified: 0 })
        continue
      }
      const targetTable = target.table(sourceTable.name)
      const copied = await copyTableRows(sourceTable, targetTable, batchSize, (row) =>
        migrateLegacyRowForAccount(sourceTable.name, row, input.targetAccountId)
      )
      const verified = await verifyCopiedRows(sourceTable, targetTable, batchSize)
      tables.push({ name: sourceTable.name, copied, verified })
    }

    await input.registry.markLegacyMigrationCompleted({
      sourceDbName,
      targetAccountId: input.targetAccountId,
      completedAt,
    })

    return {
      sourceDbName,
      targetAccountId: input.targetAccountId,
      targetDbName,
      tables,
    }
  } finally {
    source.close()
    target.close()
  }
}

async function assertRegistryAccountExists(
  registry: LocalAccountRegistry,
  accountId: string
): Promise<void> {
  const accounts = await registry.listAccounts()
  if (!accounts.some((account) => account.id === accountId)) {
    throw new Error(`Local account ${accountId} does not exist.`)
  }
}

function normalizeBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return DEFAULT_LEGACY_MIGRATION_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("Legacy migration batch size must be a positive integer.")
  }
  return batchSize
}

async function copyTableRows(
  sourceTable: Dexie.Table,
  targetTable: Dexie.Table,
  batchSize: number,
  transform: (row: unknown) => unknown = (row) => row
): Promise<number> {
  let copied = 0
  let offset = 0

  while (true) {
    const rows = await sourceTable.offset(offset).limit(batchSize).toArray()
    if (rows.length === 0) return copied
    await targetTable.bulkPut(rows.map(transform))
    copied += rows.length
    offset += rows.length
  }
}

function migrateLegacyRowForAccount(
  tableName: string,
  row: unknown,
  targetAccountId: string
): unknown {
  if (tableName !== "mobileOutboundQueue" || !row || typeof row !== "object") {
    return row
  }
  const queueRow = row as Partial<MobileOutboundJobRow>
  if (queueRow.accountId && queueRow.accountId !== "legacy-unscoped" && queueRow.targetId) {
    return row
  }
  return {
    ...queueRow,
    accountId: targetAccountId,
    targetId: LEGACY_MIXED_TARGET_ID,
    status: "deadlettered",
    lastError: "Legacy outbound action could not be safely attributed to a runtime target.",
  } satisfies Partial<MobileOutboundJobRow>
}

async function verifyCopiedRows(
  sourceTable: Dexie.Table,
  targetTable: Dexie.Table,
  batchSize: number
): Promise<number> {
  let verified = 0
  let offset = 0

  while (true) {
    const keys = await sourceTable.offset(offset).limit(batchSize).primaryKeys()
    if (keys.length === 0) return verified
    const rows = await targetTable.bulkGet(keys)
    const missingIndex = rows.findIndex((row) => row === undefined)
    if (missingIndex >= 0) {
      throw new Error(
        `Legacy migration verification failed for table ${sourceTable.name}; missing primary key ${String(keys[missingIndex])}.`
      )
    }
    verified += keys.length
    offset += keys.length
  }
}
