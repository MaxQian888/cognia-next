/**
 * AppData directories holding an account's data outside its database: the
 * videos workflow jobs generate (ADR-0205) and the composer's FFmpeg staging
 * copies.
 *
 * Each is laid out `<dir>/<accountId>/<databaseName>/…`. The account level lets
 * account deletion remove everything an account left on disk without opening
 * its database (a locked account's database is encrypted). The database level
 * lets "clear all data" remove what the one database it drops pointed at, and
 * leaves the same account's other databases (runtime targets) alone.
 *
 * Both removals are best-effort at the moment they run, because the data they
 * belong to is already gone and a file held open elsewhere must not fail the
 * deletion. {@link sweepDroppedDatabaseAppData} is the retry: the retention
 * sweep removes every database directory whose database no longer exists.
 *
 * Desktop only: AppData is written through the Tauri fs plugin, so on every
 * other host these directories do not exist and each function is a no-op.
 */

import { assertAccountId } from "@/lib/accounts/account-types"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { detectHostProfile } from "@/lib/platform/capabilities"
import { listAppDataDirectory, removeAppDataDirectory } from "@/lib/tauri/app-data-files"

/** The videos `action.media.generateVideo` jobs produce. */
export const GENERATED_VIDEO_APP_DATA_DIR = "generated-videos"
/** Copies of composer videos staged for FFmpeg; each lives for one preparation. */
export const COMPOSER_VIDEO_STAGING_APP_DATA_DIR = "composer-video-staging"

/** Every account-scoped AppData directory, so a purge or sweep misses none. */
export const ACCOUNT_APP_DATA_DIRS = [
  GENERATED_VIDEO_APP_DATA_DIR,
  COMPOSER_VIDEO_STAGING_APP_DATA_DIR,
] as const

export type AccountAppDataDir = (typeof ACCOUNT_APP_DATA_DIRS)[number]

/** Dexie database names are made of account and target ids, both this alphabet. */
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/

function assertDatabaseName(databaseName: string): string {
  if (!DATABASE_NAME.test(databaseName)) {
    throw new Error(`Not a database name usable as a directory: ${databaseName}`)
  }
  return databaseName
}

function hasAppData(): boolean {
  return detectHostProfile() === "desktop"
}

/** `<dir>/<accountId>/<databaseName>`, relative to AppData. */
export function databaseAppDataDir(
  dir: AccountAppDataDir,
  accountId: string,
  databaseName: string
): string {
  return `${dir}/${assertAccountId(accountId)}/${assertDatabaseName(databaseName)}`
}

/** The directory of the database this runtime is serving. */
export function activeDatabaseAppDataDir(dir: AccountAppDataDir): string {
  return databaseAppDataDir(dir, getActiveAccountId(), getDb().name)
}

async function removeEach(paths: readonly string[]): Promise<void> {
  const failures: unknown[] = []
  for (const path of paths) {
    try {
      await removeAppDataDirectory(path)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} AppData directories were not removed`)
  }
}

/**
 * Remove everything an account keeps under AppData, across all its databases.
 * Tries every directory before throwing the failures.
 */
export async function purgeAccountAppData(accountId: string): Promise<void> {
  assertAccountId(accountId)
  if (!hasAppData()) return
  await removeEach(ACCOUNT_APP_DATA_DIRS.map((dir) => `${dir}/${accountId}`))
}

/**
 * Remove what one of an account's databases keeps under AppData. Tries every
 * directory before throwing the failures.
 */
export async function purgeDatabaseAppData(accountId: string, databaseName: string): Promise<void> {
  const paths = ACCOUNT_APP_DATA_DIRS.map((dir) => databaseAppDataDir(dir, accountId, databaseName))
  if (!hasAppData()) return
  await removeEach(paths)
}

/**
 * Remove the directory of every database that no longer exists, then any
 * account directory left empty. Entries this layout did not create (a name no
 * account or database could have, a stray file) are left alone, and a
 * directory that cannot be removed now is tried again on the next sweep.
 * Returns how many database directories were removed.
 */
export async function sweepDroppedDatabaseAppData(
  databaseExists: (databaseName: string) => Promise<boolean>
): Promise<number> {
  if (!hasAppData()) return 0
  let removed = 0
  for (const dir of ACCOUNT_APP_DATA_DIRS) {
    for (const account of await listAppDataDirectory(dir)) {
      if (!account.isDirectory) continue
      let accountDir: string
      try {
        accountDir = `${dir}/${assertAccountId(account.name)}`
      } catch {
        continue
      }
      const databases = await listAppDataDirectory(accountDir)
      let kept = databases.length
      for (const database of databases) {
        if (!database.isDirectory || !DATABASE_NAME.test(database.name)) continue
        if (await databaseExists(database.name)) continue
        try {
          await removeAppDataDirectory(`${accountDir}/${database.name}`)
          removed += 1
          kept -= 1
        } catch {
          // Held open or refused: the next sweep tries again.
        }
      }
      if (kept === 0) await removeAppDataDirectory(accountDir).catch(() => {})
    }
  }
  return removed
}
