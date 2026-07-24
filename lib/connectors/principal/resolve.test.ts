/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createFeishuPrincipal,
  setFeishuPrincipalStatus,
  setFeishuTenantStatus,
  upsertFeishuTenant,
} from "@/lib/db/feishu-principals"
import {
  getActiveRuntimeAccountId,
  hashOpenId,
  readIdentityScope,
  resolveConnectorPrincipal,
} from "./resolve"

const adapterRow = {
  settings: { larkPrincipalRegistry: true } as Record<string, unknown>,
  lastWhoamiResult: { botName: "bot", appId: "cli_1", openId: "ou_bot" },
}

const scope = { tenantKey: "tk_a", appId: "cli_1" }

async function seedResolved(accountId = "acct_a") {
  await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: accountId })
  return createFeishuPrincipal({
    tenantKey: "tk_a",
    appId: "cli_1",
    openId: "ou_1",
    cogniaAccountId: accountId,
    cogniaUserId: accountId,
  })
}

describe("resolveConnectorPrincipal", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("returns legacy for non-lark platforms", async () => {
    const result = await resolveConnectorPrincipal({
      platform: "telegram",
      adapterRow,
      remoteUserId: "u1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(result.status).toBe("legacy")
  })

  it("returns legacy when the registry flag is off", async () => {
    const result = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow: { settings: {}, lastWhoamiResult: adapterRow.lastWhoamiResult },
      remoteUserId: "ou_1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(result.status).toBe("legacy")
  })

  it("never guesses a missing tenantKey — unbound", async () => {
    await seedResolved()
    const result = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_1",
      identityScope: { appId: "cli_1" },
      activeAccountId: "acct_a",
    })
    expect(result.status).toBe("unbound")
  })

  it("falls back to the whoami appId when the envelope omits it", async () => {
    await seedResolved()
    const result = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_1",
      identityScope: { tenantKey: "tk_a" },
      activeAccountId: "acct_a",
    })
    expect(result.status).toBe("resolved")
  })

  it("returns unbound for unknown tenants and unknown principals", async () => {
    const noTenant = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(noTenant.status).toBe("unbound")

    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const noPrincipal = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_unknown",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(noPrincipal.status).toBe("unbound")
    if (noPrincipal.status === "unbound") {
      expect(noPrincipal.openIdHash).toHaveLength(12)
      expect(noPrincipal.openIdHash).not.toContain("ou_")
    }
  })

  it("rejects disabled tenants and disabled principals", async () => {
    const principal = await seedResolved()
    await setFeishuPrincipalStatus(principal.id, "disabled")
    const disabledPrincipal = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(disabledPrincipal.status).toBe("principal_disabled")

    const tenantRow = await getDb()
      .feishuTenants.where("[tenantKey+appId]")
      .equals(["tk_a", "cli_1"])
      .first()
    await setFeishuTenantStatus(tenantRow!.id, "disabled")
    const disabledTenant = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(disabledTenant.status).toBe("tenant_disabled")
  })

  it("rejects principals registered to a different account (fail closed)", async () => {
    await seedResolved("acct_other")
    const result = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(result).toEqual({ status: "cross_account", declaredAccountId: "acct_other" })
  })

  it("resolves the happy path and touches lastVerifiedAt", async () => {
    const principal = await seedResolved()
    const result = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(result.status).toBe("resolved")
    if (result.status === "resolved") {
      expect(result.principal.id).toBe(principal.id)
      expect(result.accountId).toBe("acct_a")
    }
    const stored = await getDb().feishuPrincipals.get(principal.id)
    expect(stored?.lastVerifiedAt).toBeDefined()
  })
})

describe("helpers", () => {
  it("hashOpenId is stable and hex", async () => {
    const a = await hashOpenId("ou_12345")
    const b = await hashOpenId("ou_12345")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(await hashOpenId("ou_other")).not.toBe(a)
  })

  it("readIdentityScope tolerates malformed channelData", () => {
    expect(readIdentityScope(undefined)).toBeUndefined()
    expect(readIdentityScope({})).toBeUndefined()
    expect(readIdentityScope({ identityScope: "nope" })).toBeUndefined()
    expect(readIdentityScope({ identityScope: {} })).toBeUndefined()
    expect(readIdentityScope({ identityScope: { tenantKey: "tk", appId: 5 } })).toEqual({
      tenantKey: "tk",
      appId: undefined,
    })
  })

  it("getActiveRuntimeAccountId derives from the active account database name", () => {
    expect(getActiveRuntimeAccountId()).toBe(process.env.COGNIA_LOCAL_ACCOUNT_ID ?? "local_acct_a")
  })
})
