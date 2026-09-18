// Notification V2 scope contract.
//
// A scope pins every notification fact to a stable authorization/data domain.
// It deliberately separates the concepts the V1 record conflated: the old
// `projectId` comment admitted it labelled the *source workspace*, while V2
// keeps workspace, business project, account and host authority as distinct
// fields so a Host migration or a focus switch cannot re-key an old event.
//
// `scopeKey` is the canonical encoding of the STABLE fields only — namespace,
// account, workspace and business project. It never contains the current
// focus, a display name, the authority host or its epoch: those change under
// a user's feet and would mint a "new" event for the same fact.

/**
 * Authorization / data domain for one notification fact.
 *
 * Every field maps to an existing repository concept; when the concept does
 * not exist for a producer the field stays absent rather than being
 * fabricated (no fake workspace / project ids).
 */
export interface NotificationScope {
  /**
   * Stable authorization/data domain id. Migrating the notification Host does
   * NOT change it — it is the thing hosts take turns owning. Defaults to the
   * local account database name (`LEGACY_COGNIA_DB_NAME` or
   * `cognia-account-<id>`), which is exactly the boundary sync and encryption
   * already draw.
   */
  namespaceId: string
  /**
   * The account that owns the inbox this fact lands in. Taken from the
   * session / initiator / settings identity — never inferred from a display
   * name. Falls back to `"local"` on single-account installs.
   */
  accountId: string
  /** The control-plane Host currently authoritative for this namespace. */
  authorityHostId: string
  /** Where the work actually ran — may differ from the notifying Host. */
  executionHostId?: string
  /** Runtime/session provenance when the producer knows it. */
  runtimeId?: string
  /** The workspace (`Project` id) the fact came FROM — the V1 `projectId` slot. */
  workspaceId?: string
  /**
   * A business project id when the product model grows one. Kept separate
   * from {@link workspaceId} so the old field is never silently reinterpreted.
   */
  businessProjectId?: string
}

/** The inbox owner inside a scope. Defaults to the scope's account. */
export type NotificationPrincipalId = string

/** Fields that participate in `scopeKey` — the STABLE identity only. */
export interface NotificationScopeKeyFields {
  namespaceId: string
  accountId: string
  workspaceId?: string
  businessProjectId?: string
}

const SEP = "\u001f"

function enc(value: string | undefined): string {
  return encodeURIComponent(value ?? "")
}

/**
 * Canonical, reversible scope encoding. `encodeURIComponent` keeps the
 * separator unambiguous even when ids contain it. Order is fixed; absent
 * trailing fields encode as empty segments so the key is stable under
 * addition of later-known fields being ABSENT, not present-but-empty.
 */
export function notificationScopeKey(fields: NotificationScopeKeyFields): string {
  return [
    enc(fields.namespaceId),
    enc(fields.accountId),
    enc(fields.workspaceId),
    enc(fields.businessProjectId),
  ].join(SEP)
}

export function scopeKeyOf(scope: NotificationScope): string {
  return notificationScopeKey(scope)
}

/**
 * The namespace+account scopeKey PREFIX — `{ns}{SEP}{account}{SEP}`. Used to
 * match every workspace scopeKey one account wrote: the trailing SEP after
 * `accountId` is load-bearing — without it `{ns}:{abc}` would prefix-match
 * `{ns}:{abcd}` (a different account). A full workspace key
 * `{ns}{SEP}{account}{SEP}{ws}{SEP}` startsWith this prefix; a foreign
 * account's key does not.
 */
export function notificationAccountScopePrefix(fields: {
  namespaceId: string
  accountId: string
}): string {
  return `${enc(fields.namespaceId)}${SEP}${enc(fields.accountId)}${SEP}`
}

/** Decode a `scopeKey` back to its stable fields (diagnostics only). */
export function parseNotificationScopeKey(key: string): NotificationScopeKeyFields {
  const [namespaceId = "", accountId = "", workspaceId = "", businessProjectId = ""] = key
    .split(SEP)
    .map((part) => decodeURIComponent(part))
  return {
    namespaceId,
    accountId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(businessProjectId ? { businessProjectId } : {}),
  }
}

/**
 * Maps the legacy `NotificationRecord.projectId` onto the V2 scope.
 *
 * The old field labelled the source WORKSPACE — the resolver is explicit so
 * it is never silently reinterpreted as a business project. A historical
 * record whose workspace no longer resolves keeps `workspaceId` unset on the
 * scope (legacy scope) rather than inventing a binding.
 */
export function scopeFromLegacy(input: {
  namespaceId: string
  accountId: string
  authorityHostId: string
  legacyProjectId?: string
}): NotificationScope {
  return {
    namespaceId: input.namespaceId,
    accountId: input.accountId,
    authorityHostId: input.authorityHostId,
    ...(input.legacyProjectId ? { workspaceId: input.legacyProjectId } : {}),
  }
}
