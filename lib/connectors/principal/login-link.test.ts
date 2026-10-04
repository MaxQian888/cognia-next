/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createFeishuPrincipal,
  getFeishuPrincipalById,
  setFeishuPrincipalStatus,
} from "@/lib/db/feishu-principals"
import { linkExternalIdentity } from "@/lib/db/identity"
import type { ExternalIdentity } from "@/types/identity"
import {
  attachSignInToFeishuPrincipals,
  bindRequestMatchesOwner,
  logtoSubjectForUser,
  readSignedInOwner,
  unlinkSelfBoundPrincipals,
} from "./login-link"

const T0 = 1_800_000_000_000

function larkIdentity(overrides: Partial<ExternalIdentity> = {}): ExternalIdentity {
  return {
    id: "lark:tk_a:on_ada",
    userId: "usr_ada",
    provider: "lark",
    subject: "on_ada",
    tenant: "tk_a",
    linkedAt: T0,
    ...overrides,
  }
}

async function principal(input: {
  appId?: string
  openId: string
  unionId?: string
  tenantKey?: string
  cogniaUserId?: string
  logtoSubject?: string
}) {
  return createFeishuPrincipal({
    tenantKey: input.tenantKey ?? "tk_a",
    appId: input.appId ?? "cli_1",
    openId: input.openId,
    ...(input.unionId ? { unionId: input.unionId } : {}),
    cogniaAccountId: "acct_a",
    cogniaUserId: input.cogniaUserId ?? "usr_ada",
    ...(input.logtoSubject ? { logtoSubject: input.logtoSubject } : {}),
    now: T0,
  })
}

describe("login-link", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  describe("attachSignInToFeishuPrincipals", () => {
    it("writes the login subject onto every principal of the person, across apps", async () => {
      const one = await principal({ openId: "ou_1", unionId: "on_ada" })
      const two = await principal({ appId: "cli_2", openId: "ou_2", unionId: "on_ada" })

      const report = await attachSignInToFeishuPrincipals({
        userId: "usr_ada",
        logtoSubject: "sub_ada",
        identities: [larkIdentity()],
        now: T0 + 1,
      })

      expect(report.attached.sort()).toEqual([one.id, two.id].sort())
      expect(report.foreign).toEqual([])
      const stored = await getFeishuPrincipalById(one.id)
      expect(stored?.logtoSubject).toBe("sub_ada")
      expect(stored?.version).toBe(one.version + 1)
    })

    it("reports, and never takes over, a matching principal of another person", async () => {
      const foreign = await principal({
        openId: "ou_1",
        unionId: "on_ada",
        cogniaUserId: "usr_imfirst",
      })

      const report = await attachSignInToFeishuPrincipals({
        userId: "usr_ada",
        logtoSubject: "sub_ada",
        identities: [larkIdentity()],
      })

      expect(report).toEqual({ attached: [], foreign: [foreign.id] })
      expect((await getFeishuPrincipalById(foreign.id))?.logtoSubject).toBeUndefined()
    })

    it("keeps a subject the principal already records", async () => {
      const existing = await principal({
        openId: "ou_1",
        unionId: "on_ada",
        logtoSubject: "sub_first",
      })

      const report = await attachSignInToFeishuPrincipals({
        userId: "usr_ada",
        logtoSubject: "sub_second",
        identities: [larkIdentity()],
      })

      expect(report.attached).toEqual([])
      const stored = await getFeishuPrincipalById(existing.id)
      expect(stored?.logtoSubject).toBe("sub_first")
      expect(stored?.version).toBe(existing.version)
    })

    it("ignores non-Feishu, untenanted and other people's identities", async () => {
      const own = await principal({ openId: "ou_1", unionId: "on_ada" })

      const report = await attachSignInToFeishuPrincipals({
        userId: "usr_ada",
        logtoSubject: "sub_ada",
        identities: [
          larkIdentity({ provider: "github", tenant: undefined }),
          // Untenanted lark subjects cannot be told apart from open ids.
          larkIdentity({ tenant: undefined }),
          larkIdentity({ userId: "usr_other" }),
          // Same union id text, other tenant.
          larkIdentity({ tenant: "tk_b" }),
        ],
      })

      expect(report.attached).toEqual([])
      expect((await getFeishuPrincipalById(own.id))?.logtoSubject).toBeUndefined()
    })

    it("does nothing for a blank subject", async () => {
      await principal({ openId: "ou_1", unionId: "on_ada" })
      const report = await attachSignInToFeishuPrincipals({
        userId: "usr_ada",
        logtoSubject: "   ",
        identities: [larkIdentity()],
      })
      expect(report).toEqual({ attached: [], foreign: [] })
    })
  })

  describe("logtoSubjectForUser", () => {
    it("returns the single Logto subject a person signed in with", async () => {
      await linkExternalIdentity({
        userId: "usr_ada",
        provider: "logto",
        subject: "sub_ada",
        tenant: "https://id.example/oidc",
      })
      await linkExternalIdentity({
        userId: "usr_ada",
        provider: "lark",
        subject: "on_ada",
        tenant: "tk_a",
      })
      expect(await logtoSubjectForUser("usr_ada")).toBe("sub_ada")
    })

    it("returns nothing for a person who never signed in", async () => {
      await linkExternalIdentity({
        userId: "usr_ada",
        provider: "lark",
        subject: "on_ada",
        tenant: "tk_a",
      })
      expect(await logtoSubjectForUser("usr_ada")).toBeUndefined()
    })

    it("refuses to pick between subjects from two deployments", async () => {
      await linkExternalIdentity({
        userId: "usr_ada",
        provider: "logto",
        subject: "sub_one",
        tenant: "https://one.example/oidc",
      })
      await linkExternalIdentity({
        userId: "usr_ada",
        provider: "logto",
        subject: "sub_two",
        tenant: "https://two.example/oidc",
      })
      expect(await logtoSubjectForUser("usr_ada")).toBeUndefined()
    })
  })

  describe("unlinkSelfBoundPrincipals", () => {
    it("unlinks only the active self-bound principals of that person on that profile", async () => {
      const selfBound = await createFeishuPrincipal({
        tenantKey: "tk_a",
        appId: "cli_2",
        openId: "ou_2",
        cogniaAccountId: "acct_a",
        cogniaUserId: "usr_ada",
        selfBoundAt: T0,
      })
      const confirmed = await createFeishuPrincipal({
        tenantKey: "tk_a",
        appId: "cli_1",
        openId: "ou_1",
        cogniaAccountId: "acct_a",
        cogniaUserId: "usr_ada",
        ownerConfirmedAt: T0,
      })
      const otherProfile = await createFeishuPrincipal({
        tenantKey: "tk_a",
        appId: "cli_3",
        openId: "ou_3",
        cogniaAccountId: "acct_b",
        cogniaUserId: "usr_ada",
        selfBoundAt: T0,
      })
      const disabled = await createFeishuPrincipal({
        tenantKey: "tk_a",
        appId: "cli_4",
        openId: "ou_4",
        cogniaAccountId: "acct_a",
        cogniaUserId: "usr_ada",
        selfBoundAt: T0,
      })
      await setFeishuPrincipalStatus(disabled.id, "disabled")

      const unlinked = await unlinkSelfBoundPrincipals({
        localAccountId: "acct_a",
        userId: "usr_ada",
        now: T0 + 1,
      })

      expect(unlinked).toEqual([selfBound.id])
      expect((await getFeishuPrincipalById(selfBound.id))?.status).toBe("unlinked")
      expect((await getFeishuPrincipalById(confirmed.id))?.status).toBe("active")
      expect((await getFeishuPrincipalById(otherProfile.id))?.status).toBe("active")
      // An operator's disable is not rewritten into "unlinked".
      expect((await getFeishuPrincipalById(disabled.id))?.status).toBe("disabled")
    })
  })

  describe("readSignedInOwner / bindRequestMatchesOwner", () => {
    const binding = {
      localAccountId: "acct_a",
      userId: "usr_ada",
      logtoSubject: "sub_ada",
      logtoIssuer: "https://id.example/oidc",
      displayName: "Ada",
      legacyUserIds: ["usr_derived"],
      boundAt: T0,
      updatedAt: T0,
    }

    it("reads the signed-in person, or null on an unbound profile", async () => {
      expect(await readSignedInOwner("acct_a", { get: async () => binding })).toEqual({
        userId: "usr_ada",
        legacyUserIds: ["usr_derived"],
        displayName: "Ada",
      })
      expect(await readSignedInOwner("acct_a", { get: async () => null })).toBeNull()
    })

    it("labels a request whose union id the identity plane files under the owner", async () => {
      const owner = { userId: "usr_ada", legacyUserIds: ["usr_derived"] }
      await linkExternalIdentity({
        userId: "usr_ada",
        provider: "lark",
        subject: "on_ada",
        tenant: "tk_a",
      })
      await linkExternalIdentity({
        userId: "usr_derived",
        provider: "lark",
        subject: "on_old",
        tenant: "tk_a",
      })
      await linkExternalIdentity({
        userId: "usr_bob",
        provider: "lark",
        subject: "on_bob",
        tenant: "tk_a",
      })

      expect(await bindRequestMatchesOwner({ tenantKey: "tk_a", unionId: "on_ada" }, owner)).toBe(
        true
      )
      expect(await bindRequestMatchesOwner({ tenantKey: "tk_a", unionId: "on_old" }, owner)).toBe(
        true
      )
      expect(await bindRequestMatchesOwner({ tenantKey: "tk_a", unionId: "on_bob" }, owner)).toBe(
        false
      )
      expect(await bindRequestMatchesOwner({ tenantKey: "tk_b", unionId: "on_ada" }, owner)).toBe(
        false
      )
      expect(await bindRequestMatchesOwner({ tenantKey: "tk_a" }, owner)).toBe(false)
      expect(await bindRequestMatchesOwner({ unionId: "on_ada" }, owner)).toBe(false)
    })
  })
})
