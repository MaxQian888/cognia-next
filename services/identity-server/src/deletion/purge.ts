/**
 * Purge the identities whose cooling-off period has ended (hourly cron).
 *
 * For each due person, in order:
 *   1. every registered `AccountPurgeHook` runs (see below);
 *   2. their OAuth access tokens, refresh tokens and consents are deleted;
 *   3. Better Auth deletes their sessions, linked accounts and the user row;
 *   4. the deletion request is marked purged.
 * A failure leaves the request pending, so the next run retries it; every
 * step is idempotent.
 */

import { dueDeletions, markPurged } from "./store"

/**
 * Work that must happen before an identity disappears, keyed to data other
 * services hold for that person.
 *
 * INTENTIONALLY EMPTY in phase 1: the encrypted sync space (ADR-0215 phase 3)
 * is the first data to purge with the account, and it registers its hook
 * then. Until it exists there is nothing outside this database to delete,
 * which `purge.test.ts` pins by asserting the default registry is empty.
 */
export type AccountPurgeHook = (userId: string) => Promise<void>

export const DEFAULT_PURGE_HOOKS: readonly AccountPurgeHook[] = []

export interface PurgeDeps {
  db: D1Database
  deleteUser: (userId: string) => Promise<void>
  hooks?: readonly AccountPurgeHook[]
  now?: () => Date
  batchSize?: number
}

export interface PurgeReport {
  purged: string[]
  failed: { userId: string; error: string }[]
}

const OAUTH_TABLES = ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"] as const

export async function purgeDueDeletions(deps: PurgeDeps): Promise<PurgeReport> {
  const now = deps.now?.() ?? new Date()
  const hooks = deps.hooks ?? DEFAULT_PURGE_HOOKS
  const report: PurgeReport = { purged: [], failed: [] }
  for (const userId of await dueDeletions(deps.db, now, deps.batchSize ?? 25)) {
    try {
      for (const hook of hooks) await hook(userId)
      await deps.db.batch(
        OAUTH_TABLES.map((table) =>
          deps.db.prepare(`DELETE FROM "${table}" WHERE "userId" = ?`).bind(userId)
        )
      )
      await deps.deleteUser(userId)
      await markPurged(deps.db, userId, now)
      report.purged.push(userId)
    } catch (error) {
      report.failed.push({ userId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}
