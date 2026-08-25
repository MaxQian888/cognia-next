import {
  getUser,
  linkExternalIdentity,
  listExternalIdentities,
  upsertUser,
} from "@/lib/db/identity"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import {
  larkFallbackDisplayName,
  larkOpenIdTenant,
  larkPersonSubjects,
  larkUnionIdTenant,
  resolveLarkPerson,
} from "./person"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  const db = getDb()
  await Promise.all([db.users.clear(), db.externalIdentities.clear()])
})
afterAll(dbFixture.dispose)

describe("larkPersonSubjects", () => {
  it("ranks the IdP's answer first, then the cross-app id, then the app-scoped one", () => {
    expect(
      larkPersonSubjects({
        tenantKey: "tk_1",
        appId: "app_1",
        openId: "ou_ada",
        unionId: "on_ada",
        logtoSubject: "logto_ada",
      })
    ).toEqual([
      { provider: "logto", subject: "logto_ada" },
      { provider: "lark", subject: "on_ada", tenant: "tk_1" },
      { provider: "lark", subject: "ou_ada", tenant: "tk_1/app_1" },
    ])
  })

  it("always offers the open id, even when it is the only one there is", () => {
    expect(larkPersonSubjects({ tenantKey: "tk_1", appId: "app_1", openId: "ou_ada" })).toEqual([
      { provider: "lark", subject: "ou_ada", tenant: "tk_1/app_1" },
    ])
  })

  it("scopes an open id to its app and a union id to its tenant", () => {
    // Not cosmetic: an open_id is minted per app, so filing two apps' ids
    // under one tenant would let one app's id answer for another's.
    expect(larkOpenIdTenant("tk_1", "app_1")).toBe("tk_1/app_1")
    expect(larkOpenIdTenant("tk_1", "app_2")).not.toBe(larkOpenIdTenant("tk_1", "app_1"))
    expect(larkUnionIdTenant("tk_1")).toBe("tk_1")
  })
})

describe("larkFallbackDisplayName", () => {
  it("names an unknown sender by the hash, never by the open id", async () => {
    const label = await larkFallbackDisplayName("ou_ada")
    expect(label).not.toContain("ou_ada")
    expect(label).toMatch(/^Lark [0-9a-f]{12}$/)
    // Stable, so the same stranger is the same row on the next message.
    expect(await larkFallbackDisplayName("ou_ada")).toBe(label)
  })
})

describe("resolveLarkPerson", () => {
  it("mints a person from the open id and prefers the directory's name", async () => {
    const result = await resolveLarkPerson({
      tenantKey: "tk_1",
      appId: "app_1",
      openId: "ou_ada",
      displayName: "Ada Lovelace",
      now: 100,
    })

    expect(result.created).toBe(true)
    expect((await getUser(result.userId))?.displayName).toBe("Ada Lovelace")
    expect(await listExternalIdentities(result.userId)).toMatchObject([
      { provider: "lark", subject: "ou_ada", tenant: "tk_1/app_1" },
    ])
  })

  it("falls back to the hashed label when the directory has no name", async () => {
    const result = await resolveLarkPerson({
      tenantKey: "tk_1",
      appId: "app_1",
      openId: "ou_ada",
      displayName: "   ",
      now: 100,
    })

    expect((await getUser(result.userId))?.displayName).toBe(
      await larkFallbackDisplayName("ou_ada")
    )
  })

  it("converges on the web person when the principal already carries a logto subject", async () => {
    // This is the property ADR-0149 §3 is for: the same human arriving from
    // Lark today and from the web yesterday is ONE person.
    await upsertUser({ id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 })
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "logto",
      subject: "logto_ada",
      tenant: "https://logto.example.com/oidc",
      now: 1,
    })

    const result = await resolveLarkPerson({
      tenantKey: "tk_1",
      appId: "app_1",
      openId: "ou_ada",
      logtoSubject: "logto_ada",
      displayName: "Ada",
      now: 200,
    })

    expect(result.userId).toBe("usr_ada")
    expect(result.created).toBe(false)
    expect(await getDb().users.count()).toBe(1)
  })

  it("keeps one person across two apps once a union id is known", async () => {
    const first = await resolveLarkPerson({
      tenantKey: "tk_1",
      appId: "app_1",
      openId: "ou_app1",
      unionId: "on_ada",
      displayName: "Ada",
      now: 100,
    })
    const second = await resolveLarkPerson({
      tenantKey: "tk_1",
      appId: "app_2",
      openId: "ou_app2",
      unionId: "on_ada",
      displayName: "Ada",
      now: 200,
    })

    expect(second.userId).toBe(first.userId)
    expect(second.created).toBe(false)
    // Both app-scoped ids now point at her, plus the union id.
    expect((await listExternalIdentities(first.userId)).map((row) => row.id).sort()).toEqual([
      "lark:tk_1/app_1:ou_app1",
      "lark:tk_1/app_2:ou_app2",
      "lark:tk_1:on_ada",
    ])
  })

  it("keeps two people apart when only app-scoped ids are known", async () => {
    const first = await resolveLarkPerson({
      tenantKey: "tk_1",
      appId: "app_1",
      openId: "ou_app1",
      now: 100,
    })
    const second = await resolveLarkPerson({
      tenantKey: "tk_1",
      appId: "app_2",
      openId: "ou_app2",
      now: 200,
    })

    // Without a union id there is no evidence these are one human, and
    // inventing that evidence would merge two strangers.
    expect(second.userId).not.toBe(first.userId)
  })
})
