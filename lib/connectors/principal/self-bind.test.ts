/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { UserBindingRow } from "@/lib/accounts/account-db"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createFeishuPrincipal,
  getFeishuPrincipal,
  setFeishuPrincipalStatus,
  setFeishuTenantStatus,
  upsertFeishuTenant,
} from "@/lib/db/feishu-principals"
import { findUserIdByExternalIdentity, linkExternalIdentity } from "@/lib/db/identity"
import type { AuditEntry } from "@/types/connectors/audit"
import {
  isForgeResistantTransport,
  selfBindSignedInOwner,
  type SelfBindDependencies,
  type SelfBindInput,
} from "./self-bind"

const T0 = 1_800_000_000_000
const SCOPE = { tenantKey: "tk_a", appId: "cli_2", unionId: "on_ada" }

function ownerBinding(overrides: Partial<UserBindingRow> = {}): UserBindingRow {
  return {
    localAccountId: "acct_a",
    userId: "usr_ada",
    logtoSubject: "sub_ada",
    logtoIssuer: "https://id.example/oidc",
    displayName: "Ada",
    boundAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

function deps(
  binding: UserBindingRow | null = ownerBinding(),
  secrets: Record<string, string> = {}
) {
  const rows: AuditEntry[] = []
  const audit = jest.fn(async (entry: Omit<AuditEntry, "id"> & { id?: string }) => {
    const row = { id: `a${rows.length}`, ...entry } as AuditEntry
    rows.push(row)
    return row
  })
  const overrides: Partial<SelfBindDependencies> = {
    binding: jest.fn(async () => binding),
    readSecret: jest.fn(async (_adapterId: string, account: string) => secrets[account]),
    audit: audit as unknown as SelfBindDependencies["audit"],
    now: () => T0,
  }
  return { rows, overrides }
}

function input(overrides: Partial<SelfBindInput> = {}): SelfBindInput {
  return {
    adapterId: "lark-2",
    transportModes: ["gateway"],
    openId: "ou_ada_app2",
    identityScope: SCOPE,
    accountId: "acct_a",
    conversationKey: "lark:lark-2:oc_1",
    ...overrides,
  }
}

/** The owner approved their principal in app 1 "as me". */
async function ownerConfirmedInApp1(overrides: { status?: "active" | "disabled" } = {}) {
  const principal = await createFeishuPrincipal({
    tenantKey: "tk_a",
    appId: "cli_1",
    openId: "ou_ada_app1",
    unionId: "on_ada",
    cogniaAccountId: "acct_a",
    cogniaUserId: "usr_ada",
    ownerConfirmedAt: T0 - 10,
    now: T0 - 10,
  })
  if (overrides.status === "disabled") await setFeishuPrincipalStatus(principal.id, "disabled")
  return principal
}

describe("selfBindSignedInOwner", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_2", cogniaAccountId: "acct_a" })
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("admits the owner in another app once they confirmed themselves in one", async () => {
    await ownerConfirmedInApp1()
    const { rows, overrides } = deps()

    const result = await selfBindSignedInOwner(input(), overrides)

    expect(result.status).toBe("bound")
    const stored = await getFeishuPrincipal("tk_a", "cli_2", "ou_ada_app2")
    expect(stored).toMatchObject({
      cogniaAccountId: "acct_a",
      cogniaUserId: "usr_ada",
      unionId: "on_ada",
      logtoSubject: "sub_ada",
      selfBoundAt: T0,
      status: "active",
    })
    // A self-bound principal is not itself a confirmation.
    expect(stored?.ownerConfirmedAt).toBeUndefined()
    expect(await findUserIdByExternalIdentity("lark", "ou_ada_app2", "tk_a/cli_2")).toBe("usr_ada")
    const bound = rows.find((row) => row.kind === "principal.bound")
    expect(bound?.reason).toBe("signed_in_owner")
    expect(JSON.stringify(rows)).not.toContain("ou_ada_app2")
    expect(JSON.stringify(rows)).not.toContain("on_ada")
  })

  it("never admits on the identity plane's word alone", async () => {
    // The IdP / collaboration server says this union id is the owner, but the
    // owner never confirmed any principal as themselves.
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "lark",
      subject: "on_ada",
      tenant: "tk_a",
    })
    const { overrides } = deps()
    const result = await selfBindSignedInOwner(input(), overrides)
    expect(result).toEqual({ status: "skipped", reason: "not_confirmed" })
    expect(await getFeishuPrincipal("tk_a", "cli_2", "ou_ada_app2")).toBeUndefined()
  })

  it("does not accept a confirmation that is disabled, foreign, or another person's", async () => {
    const { overrides } = deps()
    await ownerConfirmedInApp1({ status: "disabled" })
    expect(await selfBindSignedInOwner(input(), overrides)).toEqual({
      status: "skipped",
      reason: "not_confirmed",
    })

    await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_3",
      openId: "ou_x",
      unionId: "on_ada",
      cogniaAccountId: "acct_other",
      cogniaUserId: "usr_ada",
      ownerConfirmedAt: T0,
    })
    await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_4",
      openId: "ou_y",
      unionId: "on_ada",
      cogniaAccountId: "acct_a",
      cogniaUserId: "usr_bob",
      ownerConfirmedAt: T0,
    })
    expect(await selfBindSignedInOwner(input(), overrides)).toEqual({
      status: "skipped",
      reason: "not_confirmed",
    })
  })

  it("accepts a confirmation filed under a legacy id the binding still carries", async () => {
    await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_ada_app1",
      unionId: "on_ada",
      cogniaAccountId: "acct_a",
      cogniaUserId: "usr_derived",
      ownerConfirmedAt: T0,
    })
    const { overrides } = deps(ownerBinding({ legacyUserIds: ["usr_derived"] }))
    const result = await selfBindSignedInOwner(input(), overrides)
    expect(result.status).toBe("bound")
    expect((await getFeishuPrincipal("tk_a", "cli_2", "ou_ada_app2"))?.cogniaUserId).toBe("usr_ada")
  })

  it("refuses a webhook checked only against the verification token", async () => {
    await ownerConfirmedInApp1()
    const { overrides } = deps()
    const result = await selfBindSignedInOwner(input({ transportModes: ["webhook"] }), overrides)
    expect(result).toEqual({ status: "skipped", reason: "transport_untrusted" })
  })

  it("accepts a webhook signed with an encrypt key", async () => {
    await ownerConfirmedInApp1()
    const { overrides } = deps(ownerBinding(), { encryptKey: "k3y" })
    const result = await selfBindSignedInOwner(input({ transportModes: ["webhook"] }), overrides)
    expect(result.status).toBe("bound")
  })

  it("requires a union id, a tenant and an app", async () => {
    await ownerConfirmedInApp1()
    const { overrides } = deps()
    for (const identityScope of [
      { tenantKey: "tk_a", appId: "cli_2" },
      { appId: "cli_2", unionId: "on_ada" },
      { tenantKey: "tk_a", unionId: "on_ada" },
      undefined,
    ]) {
      expect(await selfBindSignedInOwner(input({ identityScope }), overrides)).toEqual({
        status: "skipped",
        reason: "scope_incomplete",
      })
    }
    // The adapter's own app id stands in for a missing envelope app id.
    const fallback = await selfBindSignedInOwner(
      input({ identityScope: { tenantKey: "tk_a", unionId: "on_ada" }, fallbackAppId: "cli_2" }),
      overrides
    )
    expect(fallback.status).toBe("bound")
  })

  it("refuses an unregistered, disabled or foreign tenant", async () => {
    await ownerConfirmedInApp1()
    const { overrides } = deps()
    expect(
      await selfBindSignedInOwner(
        input({ identityScope: { ...SCOPE, appId: "cli_unknown" } }),
        overrides
      )
    ).toEqual({ status: "skipped", reason: "tenant_unknown" })

    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_2", cogniaAccountId: "acct_other" })
    expect(await selfBindSignedInOwner(input(), overrides)).toEqual({
      status: "skipped",
      reason: "tenant_foreign",
    })

    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_2", cogniaAccountId: "acct_a" })
    const tenant = await getDb()
      .feishuTenants.where("[tenantKey+appId]")
      .equals(["tk_a", "cli_2"])
      .first()
    await setFeishuTenantStatus(tenant!.id, "disabled")
    expect(await selfBindSignedInOwner(input(), overrides)).toEqual({
      status: "skipped",
      reason: "tenant_unknown",
    })
  })

  it("does nothing on a profile nobody signed in on", async () => {
    await ownerConfirmedInApp1()
    const { overrides } = deps(null)
    expect(await selfBindSignedInOwner(input(), overrides)).toEqual({
      status: "skipped",
      reason: "profile_unbound",
    })
  })

  it("re-activates its own principal a sign-out unlinked, but never an operator's disable", async () => {
    await ownerConfirmedInApp1()
    const { overrides } = deps()
    const first = await selfBindSignedInOwner(input(), overrides)
    if (first.status !== "bound") throw new Error("expected bound")

    await setFeishuPrincipalStatus(first.principal.id, "unlinked")
    const back = await selfBindSignedInOwner(input(), overrides)
    expect(back.status).toBe("bound")
    expect((await getFeishuPrincipal("tk_a", "cli_2", "ou_ada_app2"))?.status).toBe("active")

    await setFeishuPrincipalStatus(first.principal.id, "disabled")
    expect(await selfBindSignedInOwner(input(), overrides)).toEqual({
      status: "skipped",
      reason: "already_bound",
    })
    expect((await getFeishuPrincipal("tk_a", "cli_2", "ou_ada_app2"))?.status).toBe("disabled")
  })

  it("never re-activates an unlinked principal it did not create", async () => {
    await ownerConfirmedInApp1()
    const operatorRow = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_2",
      openId: "ou_ada_app2",
      cogniaAccountId: "acct_a",
      cogniaUserId: "usr_ada",
    })
    await setFeishuPrincipalStatus(operatorRow.id, "unlinked")
    const { overrides } = deps()
    expect(await selfBindSignedInOwner(input(), overrides)).toEqual({
      status: "skipped",
      reason: "already_bound",
    })
  })

  it("keeps the admission when the bookkeeping after it fails", async () => {
    await ownerConfirmedInApp1()
    const { overrides } = deps()
    overrides.audit = jest.fn(async () => {
      throw new Error("audit store closed")
    }) as unknown as SelfBindDependencies["audit"]
    const result = await selfBindSignedInOwner(input(), overrides)
    expect(result.status).toBe("bound")
    expect((await getFeishuPrincipal("tk_a", "cli_2", "ou_ada_app2"))?.status).toBe("active")
  })
})

describe("isForgeResistantTransport", () => {
  const read = (secrets: Record<string, string | undefined>) =>
    jest.fn(async (_adapterId: string, account: string) => secrets[account])

  it("trusts the long connection", async () => {
    expect(await isForgeResistantTransport("a", ["gateway"], read({}))).toBe(true)
  })

  it("trusts a webhook only with a non-empty encrypt key", async () => {
    expect(await isForgeResistantTransport("a", ["webhook"], read({ encryptKey: "k" }))).toBe(true)
    expect(await isForgeResistantTransport("a", ["webhook"], read({ encryptKey: "  " }))).toBe(
      false
    )
    expect(await isForgeResistantTransport("a", ["webhook"], read({}))).toBe(false)
  })

  it("treats an unreadable keyring and unknown transports as untrusted", async () => {
    const throwing = jest.fn(async () => {
      throw new Error("keyring locked")
    })
    expect(await isForgeResistantTransport("a", ["webhook"], throwing)).toBe(false)
    expect(await isForgeResistantTransport("a", undefined, read({}))).toBe(false)
    expect(await isForgeResistantTransport("a", ["stub"], read({}))).toBe(false)
    expect(await isForgeResistantTransport("a", ["gateway", "webhook"], read({}))).toBe(false)
  })
})
