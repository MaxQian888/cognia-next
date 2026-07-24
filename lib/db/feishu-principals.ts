/**
 * CRUD layer for the Feishu unified identity registry (Dexie v125):
 * `feishuTenants`, `feishuPrincipals`, `feishuPrincipalBindRequests`.
 *
 * These tables are the authentication authority for Lark inbound events and
 * callbacks (plan 2026-07-24 Phase 1). Uniqueness lives in the schema —
 * `&[tenantKey+appId]` and `&[tenantKey+appId+openId]` — so the same openId
 * text under a different tenant or app can never merge into one principal.
 * `platformIdentities` remains a display/contact directory only.
 */

import type {
  FeishuBindRequestStatus,
  FeishuPrincipalBindRequestRow,
  FeishuPrincipalRow,
  FeishuPrincipalStatus,
  FeishuTenantRow,
  FeishuTenantStatus,
} from "./connector-types"
import { getDb } from "./schema"

const BIND_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000

function newId(prefix: string): string {
  return prefix + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10)
}

// ─── Tenants ────────────────────────────────────────────────────────────────

export interface UpsertFeishuTenantInput {
  tenantKey: string
  appId: string
  cogniaAccountId: string
  now?: number
}

/**
 * Create or update the tenant row for (tenantKey, appId). Re-admitting an
 * existing tenant refreshes `cogniaAccountId` and re-activates it.
 */
export async function upsertFeishuTenant(input: UpsertFeishuTenantInput): Promise<FeishuTenantRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction("rw", db.feishuTenants, async () => {
    const existing = await db.feishuTenants
      .where("[tenantKey+appId]")
      .equals([input.tenantKey, input.appId])
      .first()
    if (existing) {
      const updated: FeishuTenantRow = {
        ...existing,
        cogniaAccountId: input.cogniaAccountId,
        status: "active",
        disabledAt: undefined,
        updatedAt: now,
      }
      await db.feishuTenants.put(updated)
      return updated
    }
    const row: FeishuTenantRow = {
      id: newId("ft_"),
      tenantKey: input.tenantKey,
      appId: input.appId,
      cogniaAccountId: input.cogniaAccountId,
      status: "active",
      configuredAt: now,
      updatedAt: now,
    }
    await db.feishuTenants.add(row)
    return row
  })
}

export async function getFeishuTenant(
  tenantKey: string,
  appId: string
): Promise<FeishuTenantRow | undefined> {
  return getDb().feishuTenants.where("[tenantKey+appId]").equals([tenantKey, appId]).first()
}

export async function setFeishuTenantStatus(
  id: string,
  status: FeishuTenantStatus,
  now?: number
): Promise<void> {
  const at = now ?? Date.now()
  await getDb().feishuTenants.update(id, {
    status,
    disabledAt: status === "disabled" ? at : undefined,
    updatedAt: at,
  })
}

// ─── Principals ─────────────────────────────────────────────────────────────

export interface CreateFeishuPrincipalInput {
  tenantKey: string
  appId: string
  openId: string
  unionId?: string
  cogniaAccountId: string
  cogniaUserId: string
  platformIdentityId?: string
  now?: number
}

/**
 * Create a principal. Throws when (tenantKey, appId, openId) already exists —
 * rebinding an existing principal must go through `rebindFeishuPrincipal` so
 * the version bump and audit trail stay honest.
 */
export async function createFeishuPrincipal(
  input: CreateFeishuPrincipalInput
): Promise<FeishuPrincipalRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const existing = await getFeishuPrincipal(input.tenantKey, input.appId, input.openId)
  if (existing) {
    throw new Error(
      `feishu-principals: principal already exists for ${input.tenantKey}/${input.appId}/${input.openId}`
    )
  }
  const row: FeishuPrincipalRow = {
    id: newId("fp_"),
    tenantKey: input.tenantKey,
    appId: input.appId,
    openId: input.openId,
    unionId: input.unionId,
    cogniaAccountId: input.cogniaAccountId,
    cogniaUserId: input.cogniaUserId,
    platformIdentityId: input.platformIdentityId,
    status: "active",
    linkedAt: now,
    updatedAt: now,
    version: 1,
  }
  await db.feishuPrincipals.add(row)
  return row
}

export async function getFeishuPrincipal(
  tenantKey: string,
  appId: string,
  openId: string
): Promise<FeishuPrincipalRow | undefined> {
  return getDb()
    .feishuPrincipals.where("[tenantKey+appId+openId]")
    .equals([tenantKey, appId, openId])
    .first()
}

export async function getFeishuPrincipalById(id: string): Promise<FeishuPrincipalRow | undefined> {
  return getDb().feishuPrincipals.get(id)
}

export async function setFeishuPrincipalStatus(
  id: string,
  status: FeishuPrincipalStatus,
  now?: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.feishuPrincipals, async () => {
    const current = await db.feishuPrincipals.get(id)
    if (!current) return
    await db.feishuPrincipals.update(id, {
      status,
      updatedAt: now ?? Date.now(),
      version: current.version + 1,
    })
  })
}

export interface RebindFeishuPrincipalPatch {
  cogniaUserId?: string
  logtoSubject?: string
  logtoOrganizationId?: string
  platformIdentityId?: string
  unionId?: string
}

/** Apply a rebind/linkage patch, bumping the optimistic version. */
export async function rebindFeishuPrincipal(
  id: string,
  patch: RebindFeishuPrincipalPatch,
  now?: number
): Promise<FeishuPrincipalRow> {
  const db = getDb()
  return db.transaction("rw", db.feishuPrincipals, async () => {
    const current = await db.feishuPrincipals.get(id)
    if (!current) throw new Error(`feishu-principals: principal "${id}" not found`)
    const updated: FeishuPrincipalRow = {
      ...current,
      ...patch,
      updatedAt: now ?? Date.now(),
      version: current.version + 1,
    }
    await db.feishuPrincipals.put(updated)
    return updated
  })
}

/** Throttled freshness marker — cheap best-effort, no version bump. */
export async function touchFeishuPrincipalVerification(id: string, now?: number): Promise<void> {
  await getDb().feishuPrincipals.update(id, { lastVerifiedAt: now ?? Date.now() })
}

export async function listFeishuPrincipalsByTenant(
  tenantKey: string,
  appId: string
): Promise<FeishuPrincipalRow[]> {
  const rows = await getDb()
    .feishuPrincipals.where("[tenantKey+appId]")
    .equals([tenantKey, appId])
    .toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ─── Bind requests ──────────────────────────────────────────────────────────

export interface CreateBindRequestInput {
  openId: string
  adapterId: string
  tenantKey?: string
  appId?: string
  conversationKey?: string
  now?: number
}

/**
 * Create a pending bind request for an unbound sender. Idempotent per
 * (openId, adapterId): an open (pending, unexpired) request is returned
 * as-is so repeated messages never mint new codes.
 */
export async function createBindRequest(
  input: CreateBindRequestInput
): Promise<FeishuPrincipalBindRequestRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction("rw", db.feishuPrincipalBindRequests, async () => {
    const open = await db.feishuPrincipalBindRequests
      .where("openId")
      .equals(input.openId)
      .filter(
        (row) =>
          row.adapterId === input.adapterId && row.status === "pending" && row.expiresAt > now
      )
      .first()
    if (open) return open
    const row: FeishuPrincipalBindRequestRow = {
      id: "fb_" + Math.random().toString(36).slice(2, 10),
      openId: input.openId,
      adapterId: input.adapterId,
      tenantKey: input.tenantKey,
      appId: input.appId,
      conversationKey: input.conversationKey,
      status: "pending",
      requestedAt: now,
      expiresAt: now + BIND_REQUEST_TTL_MS,
    }
    await db.feishuPrincipalBindRequests.add(row)
    return row
  })
}

export async function getBindRequest(
  code: string
): Promise<FeishuPrincipalBindRequestRow | undefined> {
  return getDb().feishuPrincipalBindRequests.get(code)
}

export interface ListBindRequestsFilter {
  adapterId?: string
  status?: FeishuBindRequestStatus
}

/** Newest-first bind requests, optionally narrowed to one adapter/status. */
export async function listBindRequests(
  filter: ListBindRequestsFilter = {}
): Promise<FeishuPrincipalBindRequestRow[]> {
  const table = getDb().feishuPrincipalBindRequests
  const rows = filter.status
    ? await table.where("status").equals(filter.status).toArray()
    : await table.toArray()
  return rows
    .filter((row) => !filter.adapterId || row.adapterId === filter.adapterId)
    .sort((a, b) => b.requestedAt - a.requestedAt)
}

/**
 * Close a pending request without minting a principal. Throws on unknown or
 * already-resolved codes so operator tooling reports the real state instead
 * of silently succeeding on a stale code.
 */
export async function rejectBindRequest(code: string, now?: number): Promise<void> {
  const db = getDb()
  const at = now ?? Date.now()
  const request = await db.feishuPrincipalBindRequests.get(code)
  if (!request) throw new Error(`feishu-principals: bind request "${code}" not found`)
  if (request.status !== "pending") {
    throw new Error(`feishu-principals: bind request "${code}" is ${request.status}`)
  }
  await db.feishuPrincipalBindRequests.update(code, { status: "rejected", resolvedAt: at })
}

export interface ApproveBindRequestInput {
  cogniaAccountId: string
  cogniaUserId: string
  now?: number
}

/**
 * Approve a pending bind request: creates the principal (the request must
 * carry tenantKey + appId — requests recorded before tenancy was known cannot
 * be approved) and marks the request approved. Throws on unknown/expired/
 * non-pending codes so operator tooling surfaces the real state.
 */
export async function approveBindRequest(
  code: string,
  input: ApproveBindRequestInput
): Promise<FeishuPrincipalRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const request = await db.feishuPrincipalBindRequests.get(code)
  if (!request) throw new Error(`feishu-principals: bind request "${code}" not found`)
  if (request.status !== "pending") {
    throw new Error(`feishu-principals: bind request "${code}" is ${request.status}`)
  }
  if (request.expiresAt <= now) {
    await db.feishuPrincipalBindRequests.update(code, { status: "expired", resolvedAt: now })
    throw new Error(`feishu-principals: bind request "${code}" expired`)
  }
  if (!request.tenantKey || !request.appId) {
    throw new Error(`feishu-principals: bind request "${code}" lacks tenant scope`)
  }
  const principal = await createFeishuPrincipal({
    tenantKey: request.tenantKey,
    appId: request.appId,
    openId: request.openId,
    cogniaAccountId: input.cogniaAccountId,
    cogniaUserId: input.cogniaUserId,
    now,
  })
  await db.feishuPrincipalBindRequests.update(code, {
    status: "approved",
    resolvedAt: now,
    resolvedPrincipalId: principal.id,
  })
  return principal
}

/** Sweep pending requests past their expiry. Returns the number expired. */
export async function expireStaleBindRequests(now?: number): Promise<number> {
  const db = getDb()
  const at = now ?? Date.now()
  const stale = await db.feishuPrincipalBindRequests
    .where("status")
    .equals("pending")
    .filter((row) => row.expiresAt <= at)
    .toArray()
  for (const row of stale) {
    await db.feishuPrincipalBindRequests.update(row.id, { status: "expired", resolvedAt: at })
  }
  return stale.length
}
