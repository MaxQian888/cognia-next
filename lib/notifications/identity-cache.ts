// Notification scope identity cache — a dependency-FREE leaf module.
//
// Why this exists as its own module: the Run Journal's
// `touchNotificationProjectionInTransaction` needs a scopeKey SYNCHRONOUSLY
// inside a Dexie transaction (an `await` would abandon it), but the full
// identity resolution (`LocalAccountRegistry`, `getDeviceId`) is async. The
// cache bridges that: it is primed early — synchronously at
// `activateAccountDatabase` (which always precedes any run write to that
// account's DB) and fully by `primeNotificationScope` — so the synchronous
// read below is already correct by the time a journal append needs it.
//
// It imports NOTHING from `lib/` so `lib/db/schema.ts` can call the setter at
// activation time without creating a schema→notifications→schema cycle.

/** The resolved notification identity — namespace + account + authority host. */
export interface NotificationIdentity {
  namespaceId: string
  accountId: string
  authorityHostId: string
}

let _identity: NotificationIdentity | null = null

/** Full prime — `resolveNotificationScope` writes all three fields. */
export function setNotificationIdentity(identity: NotificationIdentity): void {
  _identity = identity
}

/**
 * Synchronous namespace+account prime — called by `activateAccountDatabase`
 * (and `clearAccountDatabaseSelection`) the instant the active DB is known.
 * This is what makes the journal's synchronous `cachedNotificationScopeKey`
 * correct before any run write: namespaceId = the live DB name, accountId =
 * the account that owns it. `authorityHostId` (the device id) still resolves
 * async — it is not part of the scopeKey — so it keeps its prior/default value.
 */
export function setNotificationNamespaceAccount(namespaceId: string, accountId: string): void {
  _identity = {
    namespaceId,
    accountId,
    authorityHostId: _identity?.authorityHostId ?? "unknown",
  }
}

/** The primed identity, or `null` before any activation/prime. */
export function getNotificationIdentity(): NotificationIdentity | null {
  return _identity
}

/** Test hook — reset the cache between suites. */
export function __resetNotificationIdentityForTesting(): void {
  _identity = null
}
