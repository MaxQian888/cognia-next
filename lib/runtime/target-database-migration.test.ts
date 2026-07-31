/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import Dexie from "dexie"

import { accountDatabaseName } from "@/lib/accounts/account-db"
import { CogniaDB } from "@/lib/db/schema"
import {
  TARGET_MIGRATION_JOURNAL_DB_NAME,
  TargetDatabaseMigrationJournal,
  markTargetDatabaseMigrationCompleted,
  migrateAccountDatabaseToTarget,
} from "./target-database-migration"
import { runtimeTargetDatabaseName } from "./target-registry"

const accountId = "acct_target_migration"
const targetId = "web-standalone"
const sourceName = accountDatabaseName(accountId)
const targetName = runtimeTargetDatabaseName(accountId, targetId)

beforeEach(async () => {
  await Promise.all([
    Dexie.delete(sourceName),
    Dexie.delete(targetName),
    Dexie.delete(TARGET_MIGRATION_JOURNAL_DB_NAME),
  ])
})

afterAll(async () => {
  await Promise.all([
    Dexie.delete(sourceName),
    Dexie.delete(targetName),
    Dexie.delete(TARGET_MIGRATION_JOURNAL_DB_NAME),
  ])
})

it("copies and verifies source rows before reporting the migration as verified", async () => {
  const source = new CogniaDB(sourceName)
  await source.open()
  await source.sessions.put({
    id: "session-1",
    title: "Keep me",
    kind: "direct",
    createdAt: 1,
    updatedAt: 2,
  } as never)
  source.close()

  const result = await migrateAccountDatabaseToTarget({ accountId, targetId })

  expect(result.stage).toBe("verified")
  expect(result.tables.find((table) => table.name === "sessions")).toMatchObject({
    sourceCount: 1,
    verifiedCount: 1,
  })
  const target = new CogniaDB(targetName)
  await target.open()
  await expect(target.sessions.get("session-1")).resolves.toMatchObject({
    title: "Keep me",
  })
  target.close()
})

it("records completion separately so activation can happen between verify and commit", async () => {
  await migrateAccountDatabaseToTarget({ accountId, targetId })

  await markTargetDatabaseMigrationCompleted(accountId, targetId, 99)

  const journal = new TargetDatabaseMigrationJournal()
  await expect(journal.get(accountId, targetId)).resolves.toMatchObject({
    stage: "completed",
    updatedAt: 99,
  })
  journal.close()
})

it("returns the compound journal primary key without misrepresenting it as a string", async () => {
  const journal = new TargetDatabaseMigrationJournal()
  const key: [string, string] = await journal.put({
    accountId,
    targetId,
    sourceDbName: sourceName,
    targetDbName: targetName,
    stage: "copying",
    tables: [],
    updatedAt: 10,
  })

  expect(key).toEqual([accountId, targetId])
  journal.close()
})

it("leaves a failed journal instead of claiming success", async () => {
  await expect(
    migrateAccountDatabaseToTarget({ accountId, targetId, batchSize: 0 })
  ).rejects.toThrow(/batch size/i)

  const journal = new TargetDatabaseMigrationJournal()
  await expect(journal.get(accountId, targetId)).resolves.toMatchObject({
    stage: "failed",
    error: expect.stringMatching(/batch size/i),
  })
  journal.close()
})
