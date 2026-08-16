/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createBindRequest,
  createFeishuPrincipal,
  getFeishuTenant,
  upsertFeishuTenant,
} from "@/lib/db/feishu-principals"
import { getWebSession, touchWebSession } from "@/lib/db/lark-entry"
import type { AuditEntry } from "@/types/connectors/audit"
import {
  approveFeishuBind,
  listFeishuBindRequests,
  listFeishuPrincipals,
  rebindFeishuPrincipalIdentity,
  registerFeishuTenant,
  rejectFeishuBind,
  setFeishuPrincipalEnabled,
  setFeishuTenantEnabled,
  sweepStaleFeishuBindRequests,
} from "./admin"

const NOW = 1_800_000_000_000

function auditSpy() {
  const rows: AuditEntry[] = []
  const audit = jest.fn(async (entry: Omit<AuditEntry, "id"> & { id?: string }) => {
    const row = { id: entry.id ?? `a${rows.length}`, ...entry } as AuditEntry
    rows.push(row)
    return row
  })
  return { rows, deps: { audit, now: () => NOW, activeAccountId: () => "acct_a" } }
}

async function seedPendingRequest(overrides: { tenantKey?: string; appId?: string } = {}) {
  return createBindRequest({
    openId: "ou_new",
    adapterId: "lark-1",
    tenantKey: overrides.tenantKey ?? "tk_a",
    appId: overrides.appId ?? "cli_1",
    conversationKey: "lark:lark-1:oc_1",
    now: NOW,
  })
}

describe("principal admin", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("registers a tenant idempotently and audits it", async () => {
    const { rows, deps } = auditSpy()
    const first = await registerFeishuTenant(
      { adapterId: "lark-1", tenantKey: "tk_a", appId: "cli_1" },
      deps
    )
    const second = await registerFeishuTenant(
      { adapterId: "lark-1", tenantKey: "tk_a", appId: "cli_1" },
      deps
    )
    expect(second.id).toBe(first.id)
    expect(first.cogniaAccountId).toBe("acct_a")
    expect(rows.map((r) => r.kind)).toEqual(["tenant.registered", "tenant.registered"])
    expect(rows[0]?.fields).toMatchObject({ tenantKey: "tk_a", appId: "cli_1" })
  })

  it("disables a tenant once and skips the audit when already in that state", async () => {
    const { rows, deps } = auditSpy()
    await registerFeishuTenant({ adapterId: "lark-1", tenantKey: "tk_a", appId: "cli_1" }, deps)
    await setFeishuTenantEnabled(
      { adapterId: "lark-1", tenantKey: "tk_a", appId: "cli_1", enabled: false },
      deps
    )
    await setFeishuTenantEnabled(
      { adapterId: "lark-1", tenantKey: "tk_a", appId: "cli_1", enabled: false },
      deps
    )
    expect(rows.filter((r) => r.kind === "tenant.status_changed")).toHaveLength(1)
    const stored = await getFeishuTenant("tk_a", "cli_1")
    expect(stored?.status).toBe("disabled")
  })

  it("rejects disabling a tenant that was never registered", async () => {
    const { deps } = auditSpy()
    await expect(
      setFeishuTenantEnabled(
        { adapterId: "lark-1", tenantKey: "tk_ghost", appId: "cli_1", enabled: false },
        deps
      )
    ).rejects.toThrow(/not registered/)
  })

  it("approves a bind request, auto-admitting the tenant, and never logs the raw open_id", async () => {
    const { rows, deps } = auditSpy()
    const request = await seedPendingRequest()

    const principal = await approveFeishuBind({ code: request.id }, deps)

    expect(principal.openId).toBe("ou_new")
    expect(principal.cogniaAccountId).toBe("acct_a")
    expect(principal.cogniaUserId).toBe("acct_a")
    expect(await getFeishuTenant("tk_a", "cli_1")).toBeDefined()

    const bound = rows.find((r) => r.kind === "principal.bound")
    expect(bound?.fields?.openIdHash).toMatch(/^[0-9a-f]{12}$/)
    expect(JSON.stringify(rows)).not.toContain("ou_new")

    const stored = await getDb().feishuPrincipalBindRequests.get(request.id)
    expect(stored?.status).toBe("approved")
    expect(stored?.resolvedPrincipalId).toBe(principal.id)
  })

  it("stores the Logto linkage supplied at approval time", async () => {
    const { deps } = auditSpy()
    const request = await seedPendingRequest()
    const principal = await approveFeishuBind(
      { code: request.id, logtoSubject: "sub_1", logtoOrganizationId: "org_1" },
      deps
    )
    expect(principal.logtoSubject).toBe("sub_1")
    expect(principal.logtoOrganizationId).toBe("org_1")
  })

  it("refuses to approve a request that carries no tenant scope", async () => {
    const { deps } = auditSpy()
    const request = await createBindRequest({
      openId: "ou_scopeless",
      adapterId: "lark-1",
      now: NOW,
    })
    await expect(approveFeishuBind({ code: request.id }, deps)).rejects.toThrow(
      /lacks tenant scope/
    )
    expect(await getFeishuTenant("tk_a", "cli_1")).toBeUndefined()
  })

  it("rejects a pending request and refuses a second resolution", async () => {
    const { rows, deps } = auditSpy()
    const request = await seedPendingRequest()
    await rejectFeishuBind(request.id, deps)

    const stored = await getDb().feishuPrincipalBindRequests.get(request.id)
    expect(stored?.status).toBe("rejected")
    expect(rows.some((r) => r.kind === "principal.bind_rejected")).toBe(true)
    await expect(approveFeishuBind({ code: request.id }, deps)).rejects.toThrow(/is rejected/)
  })

  it("lists bind requests newest-first, filtered by adapter and status", async () => {
    await createBindRequest({ openId: "ou_a", adapterId: "lark-1", now: NOW })
    await createBindRequest({ openId: "ou_b", adapterId: "lark-1", now: NOW + 10 })
    await createBindRequest({ openId: "ou_c", adapterId: "lark-2", now: NOW + 20 })

    const mine = await listFeishuBindRequests({ adapterId: "lark-1", status: "pending" })
    expect(mine.map((r) => r.openId)).toEqual(["ou_b", "ou_a"])
  })

  it("expires stale requests through the sweep", async () => {
    const { deps } = auditSpy()
    await createBindRequest({ openId: "ou_old", adapterId: "lark-1", now: 0 })
    const expired = await sweepStaleFeishuBindRequests(deps)
    expect(expired).toBe(1)
    const rows = await listFeishuBindRequests({ status: "expired" })
    expect(rows).toHaveLength(1)
  })

  it("changes principal status once and audits the transition", async () => {
    const { rows, deps } = auditSpy()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const principal = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })

    await setFeishuPrincipalEnabled(
      { adapterId: "lark-1", principalId: principal.id, status: "disabled" },
      deps
    )
    await setFeishuPrincipalEnabled(
      { adapterId: "lark-1", principalId: principal.id, status: "disabled" },
      deps
    )

    const changes = rows.filter((r) => r.kind === "principal.status_changed")
    expect(changes).toHaveLength(1)
    expect(changes[0]?.fields).toMatchObject({ from: "active", to: "disabled" })
    const stored = await getDb().feishuPrincipals.get(principal.id)
    expect(stored?.status).toBe("disabled")
    expect(stored?.version).toBe(2)
  })

  it("stamps the principal's web sessions when they leave active, and not when they return", async () => {
    const { rows, deps } = auditSpy()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const principal = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_sess",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })
    await touchWebSession({
      jtiHash: "ws_admin",
      adapterId: "lark-1",
      openIdHash: "hash_a",
      tenantKey: "tk_a",
      appId: "cli_1",
      principalId: principal.id,
      issuedAt: NOW,
      expiresAt: NOW + 3_600_000,
      now: NOW,
    })

    // Disabling is what actually cuts this person off (every entry intent
    // re-resolves the principal); the ledger stamp records when.
    await setFeishuPrincipalEnabled(
      { adapterId: "lark-1", principalId: principal.id, status: "disabled" },
      deps
    )
    expect((await getWebSession("ws_admin"))?.revokedAt).toBe(NOW)
    expect(rows.find((r) => r.kind === "principal.status_changed")?.fields).toMatchObject({
      revokedSessions: 1,
    })

    // Re-enabling does not resurrect the row — the session it referred to is
    // long gone; the person simply signs in again.
    await setFeishuPrincipalEnabled(
      { adapterId: "lark-1", principalId: principal.id, status: "active" },
      deps
    )
    expect((await getWebSession("ws_admin"))?.revokedAt).toBe(NOW)
    const backToActive = rows.filter((r) => r.kind === "principal.status_changed").at(-1)
    expect(backToActive?.fields).toMatchObject({ to: "active", revokedSessions: 0 })
  })

  it("does not fail a status change when the session ledger is unavailable", async () => {
    const { deps } = auditSpy()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const principal = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_ledgerless",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })
    const stored = await setFeishuPrincipalEnabled(
      { adapterId: "lark-1", principalId: principal.id, status: "unlinked" },
      {
        ...deps,
        revokeSessions: async () => {
          throw new Error("ledger unavailable")
        },
      }
    )
    expect(stored.status).toBe("unlinked")
    expect((await getDb().feishuPrincipals.get(principal.id))?.status).toBe("unlinked")
  })

  it("rebinds identity linkage and audits only the field names", async () => {
    const { rows, deps } = auditSpy()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const principal = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })

    const updated = await rebindFeishuPrincipalIdentity(
      {
        adapterId: "lark-1",
        principalId: principal.id,
        patch: { cogniaUserId: "user_7", logtoSubject: "sub_secret" },
      },
      deps
    )

    expect(updated.cogniaUserId).toBe("user_7")
    expect(updated.version).toBe(2)
    const rebound = rows.find((r) => r.kind === "principal.rebound")
    expect(rebound?.fields?.changed).toEqual(["cogniaUserId", "logtoSubject"])
    expect(JSON.stringify(rows)).not.toContain("sub_secret")
  })

  it("treats an empty rebind patch as a no-op without an audit row", async () => {
    const { rows, deps } = auditSpy()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const principal = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })
    const same = await rebindFeishuPrincipalIdentity(
      { adapterId: "lark-1", principalId: principal.id, patch: {} },
      deps
    )
    expect(same.version).toBe(1)
    expect(rows.some((r) => r.kind === "principal.rebound")).toBe(false)
  })

  it("lists principals for a tenant", async () => {
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })
    expect(await listFeishuPrincipals("tk_a", "cli_1")).toHaveLength(1)
    expect(await listFeishuPrincipals("tk_other", "cli_1")).toHaveLength(0)
  })

  it("surfaces unknown ids instead of failing silently", async () => {
    const { deps } = auditSpy()
    await expect(approveFeishuBind({ code: "nope" }, deps)).rejects.toThrow(/not found/)
    await expect(rejectFeishuBind("nope", deps)).rejects.toThrow(/not found/)
    await expect(
      setFeishuPrincipalEnabled(
        { adapterId: "lark-1", principalId: "fp_ghost", status: "disabled" },
        deps
      )
    ).rejects.toThrow(/not found/)
    await expect(
      rebindFeishuPrincipalIdentity(
        { adapterId: "lark-1", principalId: "fp_ghost", patch: { cogniaUserId: "u" } },
        deps
      )
    ).rejects.toThrow(/not found/)
  })
})
