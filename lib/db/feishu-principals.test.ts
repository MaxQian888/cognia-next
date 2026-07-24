/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "./schema"
import {
  approveBindRequest,
  createBindRequest,
  createFeishuPrincipal,
  expireStaleBindRequests,
  getBindRequest,
  getFeishuPrincipal,
  getFeishuTenant,
  listFeishuPrincipalsByTenant,
  rebindFeishuPrincipal,
  setFeishuPrincipalStatus,
  setFeishuTenantStatus,
  touchFeishuPrincipalVerification,
  upsertFeishuTenant,
} from "./feishu-principals"

const T0 = 1_753_000_000_000

describe("feishu-principals", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  describe("tenants", () => {
    it("creates and re-activates tenants keyed by (tenantKey, appId)", async () => {
      const created = await upsertFeishuTenant({
        tenantKey: "tk_a",
        appId: "cli_1",
        cogniaAccountId: "acct_a",
        now: T0,
      })
      expect(created.status).toBe("active")
      await setFeishuTenantStatus(created.id, "disabled", T0 + 1)
      expect((await getFeishuTenant("tk_a", "cli_1"))?.status).toBe("disabled")

      const revived = await upsertFeishuTenant({
        tenantKey: "tk_a",
        appId: "cli_1",
        cogniaAccountId: "acct_b",
        now: T0 + 2,
      })
      expect(revived.id).toBe(created.id)
      expect(revived.status).toBe("active")
      expect(revived.cogniaAccountId).toBe("acct_b")
      expect(revived.disabledAt).toBeUndefined()
    })

    it("keeps tenants with the same tenantKey but different appId separate", async () => {
      await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
      await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_2", cogniaAccountId: "acct_b" })
      expect(await getDb().feishuTenants.count()).toBe(2)
      expect((await getFeishuTenant("tk_a", "cli_1"))?.cogniaAccountId).toBe("acct_a")
      expect((await getFeishuTenant("tk_a", "cli_2"))?.cogniaAccountId).toBe("acct_b")
    })
  })

  describe("principals", () => {
    const base = {
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    }

    it("enforces uniqueness on (tenantKey, appId, openId)", async () => {
      await createFeishuPrincipal(base)
      await expect(createFeishuPrincipal(base)).rejects.toThrow(/already exists/)
    })

    it("treats the same openId under a different tenant as a different principal", async () => {
      const a = await createFeishuPrincipal(base)
      const b = await createFeishuPrincipal({ ...base, tenantKey: "tk_b" })
      expect(a.id).not.toBe(b.id)
      expect((await getFeishuPrincipal("tk_a", "cli_1", "ou_1"))?.id).toBe(a.id)
      expect((await getFeishuPrincipal("tk_b", "cli_1", "ou_1"))?.id).toBe(b.id)
    })

    it("treats the same openId under a different appId as a different principal", async () => {
      const a = await createFeishuPrincipal(base)
      const b = await createFeishuPrincipal({ ...base, appId: "cli_2" })
      expect(a.id).not.toBe(b.id)
    })

    it("bumps the version on status changes and rebinds", async () => {
      const created = await createFeishuPrincipal(base)
      expect(created.version).toBe(1)
      await setFeishuPrincipalStatus(created.id, "disabled")
      expect((await getFeishuPrincipal("tk_a", "cli_1", "ou_1"))?.version).toBe(2)
      const rebound = await rebindFeishuPrincipal(created.id, {
        logtoSubject: "logto_sub",
        logtoOrganizationId: "org_1",
      })
      expect(rebound.version).toBe(3)
      expect(rebound.logtoSubject).toBe("logto_sub")
      expect(rebound.status).toBe("disabled")
    })

    it("touches lastVerifiedAt without bumping the version", async () => {
      const created = await createFeishuPrincipal(base)
      await touchFeishuPrincipalVerification(created.id, T0)
      const row = await getFeishuPrincipal("tk_a", "cli_1", "ou_1")
      expect(row?.lastVerifiedAt).toBe(T0)
      expect(row?.version).toBe(1)
    })

    it("lists principals for one tenant scope only", async () => {
      await createFeishuPrincipal(base)
      await createFeishuPrincipal({ ...base, openId: "ou_2" })
      await createFeishuPrincipal({ ...base, tenantKey: "tk_b", openId: "ou_1" })
      const listed = await listFeishuPrincipalsByTenant("tk_a", "cli_1")
      expect(listed).toHaveLength(2)
      expect(listed.every((row) => row.tenantKey === "tk_a")).toBe(true)
    })
  })

  describe("bind requests", () => {
    const input = {
      openId: "ou_1",
      adapterId: "lk-1",
      tenantKey: "tk_a",
      appId: "cli_1",
      now: T0,
    }

    it("is idempotent per open (openId, adapterId) request", async () => {
      const first = await createBindRequest(input)
      const second = await createBindRequest({ ...input, now: T0 + 1000 })
      expect(second.id).toBe(first.id)
      // A different adapter mints its own code.
      const other = await createBindRequest({ ...input, adapterId: "lk-2" })
      expect(other.id).not.toBe(first.id)
    })

    it("approves a pending request into a principal", async () => {
      const request = await createBindRequest(input)
      const principal = await approveBindRequest(request.id, {
        cogniaAccountId: "acct_a",
        cogniaUserId: "acct_a",
        now: T0 + 1,
      })
      expect(principal.openId).toBe("ou_1")
      const resolved = await getBindRequest(request.id)
      expect(resolved?.status).toBe("approved")
      expect(resolved?.resolvedPrincipalId).toBe(principal.id)
      // Approving again fails: no double principals.
      await expect(
        approveBindRequest(request.id, { cogniaAccountId: "acct_a", cogniaUserId: "acct_a" })
      ).rejects.toThrow(/is approved/)
    })

    it("rejects approval of expired requests and sweeps them", async () => {
      const request = await createBindRequest(input)
      const later = T0 + 8 * 24 * 60 * 60 * 1000
      await expect(
        approveBindRequest(request.id, {
          cogniaAccountId: "acct_a",
          cogniaUserId: "acct_a",
          now: later,
        })
      ).rejects.toThrow(/expired/)
      // Sweep marks any remaining stale pendings.
      const again = await createBindRequest({ ...input, openId: "ou_2" })
      expect(await expireStaleBindRequests(later)).toBe(1)
      expect((await getBindRequest(again.id))?.status).toBe("expired")
    })

    it("refuses approval when the request lacks tenant scope", async () => {
      const request = await createBindRequest({ openId: "ou_9", adapterId: "lk-1", now: T0 })
      await expect(
        approveBindRequest(request.id, {
          cogniaAccountId: "acct_a",
          cogniaUserId: "acct_a",
          now: T0 + 1,
        })
      ).rejects.toThrow(/lacks tenant scope/)
    })
  })
})
