// Resolves a `NotificationScope` for the current runtime context.
//
// This is the ONE place that turns "where did this fact come from" into a
// durable authorization domain. Producers pass a `scopeHint` (what they
// already know — a bound session's account, a scheduler's workspace); the
// resolver fills the rest from the live context: namespace = the active
// account database name, accountId = the registry's active account,
// authorityHostId = this install's device id.
//
// The resolver NEVER fabricates a field it cannot source: a missing account
// falls back to `"local"` (the single-account install), a missing device id
// (SSR / pre-unlock) leaves `authorityHostId` as `"unknown"` so a later
// re-resolution can distinguish "never scoped" from "scoped to a host".

import { getDeviceId } from "@/lib/device/device-identity"
import { LocalAccountRegistry, encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import { getDb, LEGACY_COGNIA_DB_NAME } from "@/lib/db/schema"
import {
  notificationScopeKey,
  notificationAccountScopePrefix,
  type NotificationScope,
  type NotificationScopeKeyFields,
} from "@/types/notifications/scope"
import {
  getNotificationIdentity,
  setNotificationIdentity,
  __resetNotificationIdentityForTesting,
  type NotificationIdentity,
} from "./identity-cache"

/** What a producer already knows about its authorization domain. */
export interface NotificationScopeHint {
  accountId?: string
  workspaceId?: string
  businessProjectId?: string
  runtimeId?: string
  executionHostId?: string
  /** Override the namespace — a producer replaying a fact into another db. */
  namespaceId?: string
  /** Override the authority host — a thin client naming its paired host. */
  authorityHostId?: string
}

let registry: LocalAccountRegistry | null = null
function accountRegistry(): LocalAccountRegistry {
  if (!registry) registry = new LocalAccountRegistry()
  return registry
}

let _resolvedNamespace: string | null = null

/** Test hook — pin the namespace without opening a real account db. */
export function __setNotificationNamespaceForTesting(name: string | null): void {
  _resolvedNamespace = name
}

/**
 * The active account database name — the namespace boundary.
 *
 * Resolution order: an explicit test pin → the live connection's own name
 * (the actual opened account/legacy db) → a name derived from the resolved
 * account id → the legacy single-account db. Deriving from the account id
 * covers the pre-connection window (a producer resolving scope before the
 * first getDb()).
 */
function activeNamespaceId(accountId: string | null): string {
  if (_resolvedNamespace) return _resolvedNamespace
  try {
    return getDb().name
  } catch {
    // No live connection (SSR / pre-open) — derive from the account id.
  }
  if (accountId && accountId !== "local") {
    // The vault-backed account db is the encrypted variant when the install
    // uses content encryption; both share the `cognia-account-<id>` prefix
    // so the namespace prefix is stable either way.
    return encryptedAccountDatabaseName(accountId)
  }
  return LEGACY_COGNIA_DB_NAME
}

/**
 * Resolve the full scope. `hint` wins for every field it supplies; the live
 * context supplies the rest. Async because account + device lookups are.
 */
export async function resolveNotificationScope(
  hint: NotificationScopeHint = {}
): Promise<NotificationScope> {
  const accountId = hint.accountId ?? (await safeAccountId()) ?? "local"
  const authorityHostId = hint.authorityHostId ?? (await getDeviceId()) ?? "unknown"
  const namespaceId = hint.namespaceId ?? activeNamespaceId(hint.accountId ?? accountId)
  return {
    namespaceId,
    accountId,
    authorityHostId,
    ...(hint.executionHostId ? { executionHostId: hint.executionHostId } : {}),
    ...(hint.runtimeId ? { runtimeId: hint.runtimeId } : {}),
    ...(hint.workspaceId ? { workspaceId: hint.workspaceId } : {}),
    ...(hint.businessProjectId ? { businessProjectId: hint.businessProjectId } : {}),
  }
}

async function safeAccountId(): Promise<string | null> {
  try {
    return await accountRegistry().getActiveAccountId()
  } catch {
    return null
  }
}

/** The `scopeKey` a scope encodes to — convenience wrapper. */
export function scopeKeyFor(scope: NotificationScope): string {
  return notificationScopeKey(scope)
}

/**
 * The scope key used for index lookups when only the stable fields are known
 * (most list/reconcile paths). Equivalent to `notificationScopeKey` on the
 * stable subset — the authority host and runtime fields never participate.
 */
export function stableScopeKey(fields: NotificationScopeKeyFields): string {
  return notificationScopeKey(fields)
}

// ─── Synchronous identity cache ──────────────────────────────────────────────
// The Run Journal's commit-time touch runs INSIDE a Dexie transaction, where
// no non-Dexie async (device-id / account lookups) may be awaited — doing so
// abandons the IndexedDB transaction. So the identity triple lives in the
// dependency-free `identity-cache` module and is primed TWO ways before any
// run write can need it:
//   • synchronously — `activateAccountDatabase` stamps namespace+account the
//     instant the account DB is selected (always before writes to it), and
//   • fully — `primeNotificationScope` resolves the authority host too, at
//     runtime boot / first notify.
// A re-login / host migration re-primes through the same two entry points.

export type { NotificationIdentity } from "./identity-cache"

/**
 * Resolve + cache the identity triple. Called once at runtime boot and after
 * any account/host transition; safe to call repeatedly (re-resolves).
 */
export async function primeNotificationScope(): Promise<NotificationIdentity> {
  const accountId = (await safeAccountId()) ?? "local"
  const authorityHostId = (await getDeviceId()) ?? "unknown"
  const identity: NotificationIdentity = {
    namespaceId: activeNamespaceId(accountId),
    accountId,
    authorityHostId,
  }
  setNotificationIdentity(identity)
  return identity
}

/** Test hook — seed or clear the cached identity without async lookups. */
export function __setNotificationIdentityForTesting(identity: NotificationIdentity | null): void {
  if (identity === null) {
    __resetNotificationIdentityForTesting()
  } else {
    setNotificationIdentity(identity)
  }
}

/** The primed identity, or the legacy single-account defaults before prime. */
function cachedIdentity(): NotificationIdentity {
  return (
    getNotificationIdentity() ?? {
      namespaceId: LEGACY_COGNIA_DB_NAME,
      accountId: "local",
      authorityHostId: "unknown",
    }
  )
}

/**
 * Synchronous `scopeKey` for a workspace — the form the Run Journal's
 * commit-time touch needs. Uses the primed identity when available; before
 * first prime it falls back to the legacy single-account defaults, which is
 * the correct scope for the common single-account install and harmlessly
 * re-scoped on the next prime for multi-account installs.
 */
export function cachedNotificationScopeKey(
  workspaceId?: string,
  businessProjectId?: string
): string {
  const id = cachedIdentity()
  return notificationScopeKey({
    namespaceId: id.namespaceId,
    accountId: id.accountId,
    workspaceId,
    businessProjectId,
  })
}

/**
 * The namespace+account scopeKey PREFIX this host reconciles — the delivery
 * worker matches every workspace scopeKey it wrote with `startsWith`. Uses
 * the primed identity (same fallback contract as `cachedNotificationScopeKey`).
 */
export function cachedNotificationAccountPrefix(): string {
  const id = cachedIdentity()
  return notificationAccountScopePrefix({
    namespaceId: id.namespaceId,
    accountId: id.accountId,
  })
}
