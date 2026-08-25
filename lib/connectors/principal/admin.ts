/**
 * Operator use-cases for the Feishu principal registry (plan 2026-07-24
 * Phase 1, §P1.1 "tenant/app/principal 创建、禁用、解绑和重绑定流程").
 *
 * `lib/db/feishu-principals.ts` is the storage layer; this module is the only
 * place allowed to MUTATE it, so every admission, rejection, disable and
 * rebind lands in the connector audit log with the same field contract. Both
 * operator channels call these functions:
 *
 *   - the Lark adapter settings card (in-process Dexie), and
 *   - `cognia lark …`, which reaches the running brain over the companion
 *     intent bridge (a second process must NOT open the account database —
 *     headless persistence is a fake-indexeddb + JSON snapshot owned by the
 *     serve process).
 *
 * Audit hygiene mirrors `principal/unbound.ts`: an `open_id` is only ever
 * recorded as `hashOpenId()`, and a rebind records which FIELDS changed, never
 * their values.
 */

import type {
  FeishuPrincipalBindRequestRow,
  FeishuPrincipalRow,
  FeishuPrincipalStatus,
  FeishuTenantRow,
} from "@/lib/db/connector-types"
import { appendAudit } from "@/lib/connectors/audit"
import {
  approveBindRequest,
  expireStaleBindRequests,
  getBindRequest,
  getFeishuPrincipalById,
  getFeishuTenant,
  listBindRequests,
  listFeishuPrincipalsByTenant,
  rebindFeishuPrincipal,
  rejectBindRequest,
  setFeishuPrincipalStatus,
  setFeishuTenantStatus,
  upsertFeishuTenant,
  type RebindFeishuPrincipalPatch,
} from "@/lib/db/feishu-principals"
import { isUserId } from "@/types/identity"
import { bindLarkIdentityTo, resolveLarkPerson } from "./person"
import { getActiveRuntimeAccountId, hashOpenId } from "./resolve"
import { revokeWebSessionsForPrincipal } from "@/lib/db/lark-entry"

export interface PrincipalAdminDependencies {
  audit: typeof appendAudit
  now: () => number
  activeAccountId: () => string
  revokeSessions: typeof revokeWebSessionsForPrincipal
}

/**
 * The complete dependency bundle, with every default filled in.
 *
 * Exported because `bootstrap.ts` needs the same bundle and used to hand-roll a
 * partial copy of it — which silently omitted `revokeSessions` and only stayed
 * upright because its own code path never reached that dependency.
 */
export function withDefaults(
  overrides: Partial<PrincipalAdminDependencies> = {}
): PrincipalAdminDependencies {
  return {
    audit: appendAudit,
    now: Date.now,
    activeAccountId: getActiveRuntimeAccountId,
    revokeSessions: revokeWebSessionsForPrincipal,
    ...overrides,
  }
}

// ─── Tenants ────────────────────────────────────────────────────────────────

export interface RegisterTenantInput {
  adapterId: string
  tenantKey: string
  appId: string
  /** Defaults to the account this runtime currently serves. */
  accountId?: string
}

/**
 * Admit a (tenantKey, appId) pair into the registry. Idempotent — re-admitting
 * an existing tenant re-activates it and refreshes the account binding, which
 * is exactly the "operator fixed a mis-binding" flow.
 */
export async function registerFeishuTenant(
  input: RegisterTenantInput,
  overrides: Partial<PrincipalAdminDependencies> = {}
): Promise<FeishuTenantRow> {
  const deps = withDefaults(overrides)
  const now = deps.now()
  const accountId = input.accountId ?? deps.activeAccountId()
  const tenant = await upsertFeishuTenant({
    tenantKey: input.tenantKey,
    appId: input.appId,
    cogniaAccountId: accountId,
    now,
  })
  await deps.audit({
    adapterId: input.adapterId,
    kind: "tenant.registered",
    at: now,
    fields: {
      tenantId: tenant.id,
      tenantKey: tenant.tenantKey,
      appId: tenant.appId,
      accountId,
    },
  })
  return tenant
}

export interface SetTenantEnabledInput {
  adapterId: string
  tenantKey: string
  appId: string
  enabled: boolean
}

/**
 * Disable / re-enable a tenant. A disabled tenant fails closed for every
 * inbound event and callback (`resolveConnectorPrincipal` → `tenant_disabled`)
 * without deleting any principal, so the decision is reversible and auditable.
 */
export async function setFeishuTenantEnabled(
  input: SetTenantEnabledInput,
  overrides: Partial<PrincipalAdminDependencies> = {}
): Promise<FeishuTenantRow> {
  const deps = withDefaults(overrides)
  const now = deps.now()
  const tenant = await getFeishuTenant(input.tenantKey, input.appId)
  if (!tenant) {
    throw new Error(`principal-admin: tenant ${input.tenantKey}/${input.appId} is not registered`)
  }
  const next = input.enabled ? "active" : "disabled"
  if (tenant.status !== next) {
    await setFeishuTenantStatus(tenant.id, next, now)
    await deps.audit({
      adapterId: input.adapterId,
      kind: "tenant.status_changed",
      at: now,
      reason: next,
      fields: {
        tenantId: tenant.id,
        tenantKey: tenant.tenantKey,
        appId: tenant.appId,
        from: tenant.status,
        to: next,
      },
    })
  }
  return { ...tenant, status: next, updatedAt: now }
}

/**
 * Validate an operator-supplied person id — ADR-0149 §1, Batch 5.
 *
 * `cogniaUserId` used to default to the LocalProfile id, so anything at all
 * looked plausible in it. Now that the field names a real `User`, a value that
 * is not one records the wrong human in a registry whose whole job is saying
 * who somebody is. Refusing is recoverable; a mis-attributed principal is
 * found months later, if ever.
 */
function requirePersonId(value: string): string {
  if (!isUserId(value)) {
    throw new Error(
      `principal-admin: "${value}" is not a person id — ADR-0149 makes cogniaUserId a ` +
        `"usr_…" id, not a LocalProfile ("acct_…") or a free-form name.`
    )
  }
  return value
}

// ─── Bind requests ──────────────────────────────────────────────────────────

export interface ListBindRequestsInput {
  adapterId?: string
  /** Omit for every state; the admin UI defaults to pending. */
  status?: FeishuPrincipalBindRequestRow["status"]
}

export async function listFeishuBindRequests(
  input: ListBindRequestsInput = {}
): Promise<FeishuPrincipalBindRequestRow[]> {
  return listBindRequests(input)
}

export interface ApproveBindInput {
  /** The short code from the "not linked yet" reply. */
  code: string
  /** Defaults to the account this runtime currently serves. */
  accountId?: string
  /**
   * The `User` (`usr_…`) this Feishu identity belongs to. Omit and the person
   * is resolved from the platform ids — found if they already exist on the
   * identity plane, minted if they do not.
   */
  cogniaUserId?: string
  /** Web-SSO linkage captured at approval time, when known. */
  logtoSubject?: string
  logtoOrganizationId?: string
}

/**
 * Approve a pending bind request and mint the principal. The tenant row is
 * auto-admitted from the request's own tenant scope when the operator has not
 * registered it yet — approving a specific person for a tenant you can see the
 * request from IS the admission decision, and requiring two separate steps
 * only produces half-bound registries.
 */
export async function approveFeishuBind(
  input: ApproveBindInput,
  overrides: Partial<PrincipalAdminDependencies> = {}
): Promise<FeishuPrincipalRow> {
  const deps = withDefaults(overrides)
  const now = deps.now()
  const accountId = input.accountId ?? deps.activeAccountId()
  const request = await getBindRequest(input.code)
  if (!request) throw new Error(`principal-admin: bind request "${input.code}" not found`)
  if (!request.tenantKey || !request.appId) {
    throw new Error(`principal-admin: bind request "${input.code}" lacks tenant scope`)
  }

  await registerFeishuTenant(
    {
      adapterId: request.adapterId,
      tenantKey: request.tenantKey,
      appId: request.appId,
      accountId,
    },
    overrides
  )

  // ADR-0149 Batch 5 — the person, not the profile. An operator who named one
  // is making an explicit statement about who this sender is, so their id wins
  // and the Lark subject is re-pointed at it; otherwise the platform ids
  // resolve to a person on their own.
  const cogniaUserId = input.cogniaUserId
    ? requirePersonId(input.cogniaUserId)
    : (
        await resolveLarkPerson({
          tenantKey: request.tenantKey,
          appId: request.appId,
          openId: request.openId,
          ...(input.logtoSubject ? { logtoSubject: input.logtoSubject } : {}),
          now,
        })
      ).userId

  const principal = await approveBindRequest(input.code, {
    cogniaAccountId: accountId,
    cogniaUserId,
    now,
  })

  if (input.cogniaUserId) {
    await bindLarkIdentityTo({
      userId: cogniaUserId,
      tenantKey: request.tenantKey,
      appId: request.appId,
      openId: request.openId,
      now,
    })
  }

  const linkage: RebindFeishuPrincipalPatch = {}
  if (input.logtoSubject) linkage.logtoSubject = input.logtoSubject
  if (input.logtoOrganizationId) linkage.logtoOrganizationId = input.logtoOrganizationId
  const linked =
    Object.keys(linkage).length > 0
      ? await rebindFeishuPrincipal(principal.id, linkage, now)
      : principal

  await deps.audit({
    adapterId: request.adapterId,
    kind: "principal.bound",
    at: now,
    ...(request.conversationKey ? { conversationKey: request.conversationKey } : {}),
    fields: {
      bindRequestId: request.id,
      principalId: linked.id,
      tenantKey: linked.tenantKey,
      appId: linked.appId,
      openIdHash: await hashOpenId(linked.openId),
      accountId,
    },
  })
  return linked
}

/** Close a pending request without minting a principal. */
export async function rejectFeishuBind(
  code: string,
  overrides: Partial<PrincipalAdminDependencies> = {}
): Promise<void> {
  const deps = withDefaults(overrides)
  const now = deps.now()
  const request = await getBindRequest(code)
  if (!request) throw new Error(`principal-admin: bind request "${code}" not found`)
  await rejectBindRequest(code, now)
  await deps.audit({
    adapterId: request.adapterId,
    kind: "principal.bind_rejected",
    at: now,
    ...(request.conversationKey ? { conversationKey: request.conversationKey } : {}),
    fields: {
      bindRequestId: request.id,
      openIdHash: await hashOpenId(request.openId),
      tenantKey: request.tenantKey,
      appId: request.appId,
    },
  })
}

/**
 * Expire pending requests past their 7-day TTL. Wired into the connector daily
 * schedule so a stale code cannot be approved months later.
 */
export async function sweepStaleFeishuBindRequests(
  overrides: Partial<PrincipalAdminDependencies> = {}
): Promise<number> {
  const deps = withDefaults(overrides)
  return expireStaleBindRequests(deps.now())
}

// ─── Principals ─────────────────────────────────────────────────────────────

export async function listFeishuPrincipals(
  tenantKey: string,
  appId: string
): Promise<FeishuPrincipalRow[]> {
  return listFeishuPrincipalsByTenant(tenantKey, appId)
}

export interface SetPrincipalStatusInput {
  adapterId: string
  principalId: string
  status: FeishuPrincipalStatus
}

/**
 * Disable / unlink / re-activate one principal. Takes effect on the very next
 * event — `resolveConnectorPrincipal` reads the row per event, so there is no
 * cache to invalidate and an in-flight run keeps its already-authorized turn.
 */
export async function setFeishuPrincipalEnabled(
  input: SetPrincipalStatusInput,
  overrides: Partial<PrincipalAdminDependencies> = {}
): Promise<FeishuPrincipalRow> {
  const deps = withDefaults(overrides)
  const now = deps.now()
  const current = await getFeishuPrincipalById(input.principalId)
  if (!current) {
    throw new Error(`principal-admin: principal "${input.principalId}" not found`)
  }
  if (current.status === input.status) return current
  await setFeishuPrincipalStatus(input.principalId, input.status, now)
  // Leaving `active` is what actually cuts this person off — every entry
  // intent re-resolves the principal and fails closed. Stamp their session
  // ledger rows so the ops view stops showing them as live.
  const revokedSessions =
    input.status === "active" ? 0 : await deps.revokeSessions(input.principalId, now).catch(() => 0)
  await deps.audit({
    adapterId: input.adapterId,
    kind: "principal.status_changed",
    at: now,
    reason: input.status,
    fields: {
      principalId: current.id,
      tenantKey: current.tenantKey,
      appId: current.appId,
      openIdHash: await hashOpenId(current.openId),
      from: current.status,
      to: input.status,
      revokedSessions,
    },
  })
  return { ...current, status: input.status, updatedAt: now, version: current.version + 1 }
}

export interface RebindPrincipalInput {
  adapterId: string
  principalId: string
  patch: RebindFeishuPrincipalPatch
}

/**
 * Re-point a principal's Cognia-side linkage (account-local user, Logto
 * subject/organization, display identity). The audit records the field NAMES
 * that moved — the values can be user identifiers and stay out of the log.
 */
export async function rebindFeishuPrincipalIdentity(
  input: RebindPrincipalInput,
  overrides: Partial<PrincipalAdminDependencies> = {}
): Promise<FeishuPrincipalRow> {
  const deps = withDefaults(overrides)
  const now = deps.now()
  if (input.patch.cogniaUserId !== undefined) requirePersonId(input.patch.cogniaUserId)
  const changed = Object.keys(input.patch).filter(
    (key) => input.patch[key as keyof RebindFeishuPrincipalPatch] !== undefined
  )
  if (changed.length === 0) {
    const current = await getFeishuPrincipalById(input.principalId)
    if (!current) {
      throw new Error(`principal-admin: principal "${input.principalId}" not found`)
    }
    return current
  }
  const updated = await rebindFeishuPrincipal(input.principalId, input.patch, now)
  if (input.patch.cogniaUserId !== undefined) {
    // "This Lark account is actually Ada" has to move the external identity
    // too, or the next automatic resolution finds the person the subject still
    // points at and quietly undoes the operator's correction.
    await bindLarkIdentityTo({
      userId: input.patch.cogniaUserId,
      tenantKey: updated.tenantKey,
      appId: updated.appId,
      openId: updated.openId,
      ...(updated.unionId ? { unionId: updated.unionId } : {}),
      now,
    })
  }
  await deps.audit({
    adapterId: input.adapterId,
    kind: "principal.rebound",
    at: now,
    fields: {
      principalId: updated.id,
      tenantKey: updated.tenantKey,
      appId: updated.appId,
      openIdHash: await hashOpenId(updated.openId),
      version: updated.version,
      changed,
    },
  })
  return updated
}
