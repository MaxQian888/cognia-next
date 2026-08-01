/**
 * Which account this runtime is currently serving.
 *
 * The brain/desktop operates exactly one account database at a time, so the
 * active Dexie database name IS the authoritative scope — there is no separate
 * "current account" to drift from it.
 *
 * Extracted out of `lib/connectors/principal/resolve.ts`, which owned the only
 * copy. Anything wanting an account-scoped persistence key (the dock's layout
 * store, for one) would otherwise have to import the whole connectors module
 * graph — Lark envelopes, principal registries, feature flags — to ask one
 * question about the local database name.
 */

import { ACCOUNT_DB_PREFIX } from "@/lib/accounts/account-db"
import { getDb } from "@/lib/db/schema"

/** Account id assumed when the runtime predates multi-account databases. */
export const DEFAULT_LOCAL_ACCOUNT_ID = "local_acct_a"

export function getActiveAccountId(): string {
  try {
    const name = getDb().name
    if (name.startsWith(ACCOUNT_DB_PREFIX)) return name.slice(ACCOUNT_DB_PREFIX.length)
  } catch {
    // `getDb()` throws outside the browser/brain runtime (SSR pre-render, the
    // static export's build pass). Resolution never runs there, but the
    // fallback stays total so a caller can never see an exception for this.
  }
  return process.env.COGNIA_LOCAL_ACCOUNT_ID ?? DEFAULT_LOCAL_ACCOUNT_ID
}
