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
 */
export type AccountPurgeHook = (userId: string) => Promise<void>

/** The sync Worker's purge entrypoint (`SyncAdmin` in services/sync-server), over a service binding. */
export interface SyncAdminBinding {
  purgeSpace(userId: string): Promise<{ spaceId: string }>
}

/**
 * The hooks of this deployment. The encrypted sync space (ADR-0215 phase 2)
 * is deleted through `SYNC_ADMIN` when that binding exists.
 *
 * DORMANT without the binding: a deployment whose sync Worker is not live
 * (production until `cognia-sync` ships, local dev, self-host without sync)
 * has no space to delete and runs no hook. `purge.test.ts` pins both cases.
 */
export function purgeHooksFor(env: { SYNC_ADMIN?: SyncAdminBinding }): AccountPurgeHook[] {
  const syncAdmin = env.SYNC_ADMIN
  if (!syncAdmin) return []
  return [
    async (userId) => {
      await syncAdmin.purgeSpace(userId)
    },
  ]
}

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
  const hooks = deps.hooks ?? []
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
