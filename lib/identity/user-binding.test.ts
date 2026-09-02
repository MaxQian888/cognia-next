/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { ACCOUNT_REGISTRY_DB_NAME, CogniaAccountRegistryDB } from "@/lib/accounts/account-db"

import {
  UserBindingError,
  UserBindingRegistry,
  isSameBoundUser,
  type BindUserInput,
} from "./user-binding"

async function freshRegistry(testName: string) {
  const name = `${ACCOUNT_REGISTRY_DB_NAME}-${testName.replace(/[^a-z0-9_-]/gi, "-")}`
  const cleanup = new CogniaAccountRegistryDB(name)
  await cleanup.delete()
  const db = new CogniaAccountRegistryDB(name)
  return { db, registry: new UserBindingRegistry(db) }
}

function input(overrides: Partial<BindUserInput> = {}): BindUserInput {
  return {
    localAccountId: "acct_alpha",
    userId: "usr_ada",
    logtoSubject: "logto_sub_1",
    logtoIssuer: "https://logto.example.com/oidc",
    now: 1_000,
    ...overrides,
  }
}

describe("UserBindingRegistry", () => {
  it("v3 opens the userBindings store", async () => {
    const { db } = await freshRegistry("v3-store")
    await db.userBindings.put({
      localAccountId: "acct_a",
      userId: "usr_a",
      logtoSubject: "s",
      logtoIssuer: "i",
      boundAt: 1,
      updatedAt: 1,
    })
    expect(await db.userBindings.get("acct_a")).toMatchObject({ userId: "usr_a" })
  })

  it("binds a profile to a person and reads it back", async () => {
    const { registry } = await freshRegistry("bind")
    const row = await registry.bind(input({ orgId: "org_acme", displayName: "Ada" }))
    expect(row).toMatchObject({
      localAccountId: "acct_alpha",
      userId: "usr_ada",
      orgId: "org_acme",
      displayName: "Ada",
      boundAt: 1_000,
    })
    expect(await registry.get("acct_alpha")).toMatchObject({ userId: "usr_ada" })
    expect(await registry.get("acct_missing")).toBeNull()
  })

  it("is idempotent for the same person, refreshing detail and keeping boundAt", async () => {
    const { registry } = await freshRegistry("idempotent")
    await registry.bind(input())
    const again = await registry.bind(
      input({ now: 2_000, displayName: "Ada L.", orgId: "org_acme" })
    )
    expect(again.boundAt).toBe(1_000)
    expect(again.updatedAt).toBe(2_000)
    expect(again.displayName).toBe("Ada L.")
    expect(await registry.listAll()).toHaveLength(1)
  })

  it("refuses a different person, and names who is in the way", async () => {
    const { registry } = await freshRegistry("conflict")
    await registry.bind(input())
    const takeover = input({ userId: "usr_bob", logtoSubject: "logto_sub_2", now: 2_000 })

    await expect(registry.bind(takeover)).rejects.toThrow(UserBindingError)
    await expect(registry.bind(takeover)).rejects.toMatchObject({
      code: "already-bound-to-another-user",
      existing: { userId: "usr_ada" },
    })
    // And the refusal left the original binding untouched.
    expect(await registry.get("acct_alpha")).toMatchObject({ userId: "usr_ada" })
  })

  it("treats a changed Logto subject as a different person even under one user id", async () => {
    const { registry } = await freshRegistry("subject-drift")
    await registry.bind(input())
    await expect(registry.bind(input({ logtoSubject: "logto_sub_rotated" }))).rejects.toMatchObject(
      {
        code: "already-bound-to-another-user",
      }
    )
  })

  it("takes the profile over only through the explicit rebind", async () => {
    const { registry } = await freshRegistry("rebind")
    await registry.bind(input())
    const row = await registry.rebind(
      input({ userId: "usr_bob", logtoSubject: "logto_sub_2", now: 2_000 })
    )
    expect(row).toMatchObject({ userId: "usr_bob", boundAt: 2_000, updatedAt: 2_000 })
    expect(await registry.listAll()).toHaveLength(1)
  })

  it("lets one person hold several profiles — ADR-0054 isolation survives sign-in", async () => {
    const { registry } = await freshRegistry("many-profiles")
    await registry.bind(input({ localAccountId: "acct_work" }))
    await registry.bind(input({ localAccountId: "acct_personal" }))
    const rows = await registry.listByUser("usr_ada")
    expect(rows.map((row) => row.localAccountId).sort()).toEqual(["acct_personal", "acct_work"])
    expect(await registry.listByUser("usr_nobody")).toEqual([])
  })

  it("unbinds idempotently without touching anything else", async () => {
    const { registry } = await freshRegistry("unbind")
    await registry.bind(input({ localAccountId: "acct_a" }))
    await registry.bind(input({ localAccountId: "acct_b" }))
    await registry.unbind("acct_a")
    await registry.unbind("acct_a")
    expect(await registry.get("acct_a")).toBeNull()
    expect(await registry.get("acct_b")).not.toBeNull()
  })

  it("rejects ids from the vocabularies ADR-0149 replaced", async () => {
    const { registry } = await freshRegistry("id-shapes")
    await expect(registry.bind(input({ userId: "acct_alpha" }))).rejects.toMatchObject({
      code: "invalid-user-id",
    })
    await expect(registry.bind(input({ orgId: "tnt_acme" }))).rejects.toMatchObject({
      code: "invalid-org-id",
    })
  })

  it("omits absent optional fields rather than indexing undefined", async () => {
    const { db, registry } = await freshRegistry("absent-fields")
    await registry.bind(input())
    const raw = await db.userBindings.get("acct_alpha")
    expect(Object.hasOwn(raw ?? {}, "orgId")).toBe(false)
    expect(Object.hasOwn(raw ?? {}, "displayName")).toBe(false)
    // A row with no orgId must still be reachable by its primary key.
    expect(await registry.get("acct_alpha")).not.toBeNull()
  })
})

describe("isSameBoundUser", () => {
  const existing = {
    localAccountId: "acct_a",
    userId: "usr_ada",
    logtoSubject: "s1",
    logtoIssuer: "i",
    boundAt: 1,
    updatedAt: 1,
  }

  it("requires both halves to match", () => {
    expect(isSameBoundUser(existing, input({ userId: "usr_ada", logtoSubject: "s1" }))).toBe(true)
    expect(isSameBoundUser(existing, input({ userId: "usr_bob", logtoSubject: "s1" }))).toBe(false)
    expect(isSameBoundUser(existing, input({ userId: "usr_ada", logtoSubject: "s2" }))).toBe(false)
  })
})

describe("reconcileUserId (server-assigned canonical id)", () => {
  it("moves the binding to the canonical id and keeps the derived one as an alias", async () => {
    const { registry } = await freshRegistry("reconcile-moves")
    await registry.bind({
      localAccountId: "acct_a",
      userId: "usr_derived00000000000000",
      logtoSubject: "sub",
      logtoIssuer: "https://logto.test/oidc",
      orgId: "org_acme0000000000000000000",
      now: 10,
    })
    const row = await registry.reconcileUserId("acct_a", "usr_canonical0000000000000", 20)
    expect(row.userId).toBe("usr_canonical0000000000000")
    expect(row.legacyUserIds).toEqual(["usr_derived00000000000000"])
    expect(row.orgId).toBe("org_acme0000000000000000000")
    expect(row.updatedAt).toBe(20)
    expect(await registry.get("acct_a")).toEqual(row)
  })

  it("is a no-op when the ids already agree, and idempotent otherwise", async () => {
    const { registry } = await freshRegistry("reconcile-idempotent")
    await registry.bind({
      localAccountId: "acct_a",
      userId: "usr_derived00000000000000",
      logtoSubject: "sub",
      logtoIssuer: "i",
      now: 10,
    })
    await registry.reconcileUserId("acct_a", "usr_canonical0000000000000", 20)
    const again = await registry.reconcileUserId("acct_a", "usr_canonical0000000000000", 30)
    expect(again.legacyUserIds).toEqual(["usr_derived00000000000000"])
    expect(again.updatedAt).toBe(20)
  })

  it("refuses a malformed canonical id and an unbound profile", async () => {
    const { registry } = await freshRegistry("reconcile-refuses")
    await expect(registry.reconcileUserId("acct_a", "usr_x")).rejects.toMatchObject({
      code: "invalid-user-id",
    })
    await expect(
      registry.reconcileUserId("acct_a", "usr_canonical0000000000000")
    ).rejects.toMatchObject({ code: "not-bound" })
  })
})

describe("setOrgId (server-assigned org id)", () => {
  it("moves the binding to the server's org and leaves the person alone", async () => {
    const { registry } = await freshRegistry("set-org-id")
    await registry.bind({
      localAccountId: "acct_a",
      userId: "usr_ada00000000000000000000",
      logtoSubject: "sub",
      logtoIssuer: "https://logto.test/oidc",
      orgId: "org_derived0000000000000000",
      now: 10,
    })
    const row = await registry.setOrgId("acct_a", "org_server00000000000000000", 20)
    expect(row.orgId).toBe("org_server00000000000000000")
    expect(row.userId).toBe("usr_ada00000000000000000000")
    expect(row.updatedAt).toBe(20)
    // Idempotent: the same org again is not a write.
    const again = await registry.setOrgId("acct_a", "org_server00000000000000000", 30)
    expect(again.updatedAt).toBe(20)
  })

  it("refuses a value that is not an org id, and an unbound profile", async () => {
    const { registry } = await freshRegistry("set-org-id-refuses")
    await expect(registry.setOrgId("acct_a", "not-an-org")).rejects.toMatchObject({
      code: "invalid-org-id",
    })
    await expect(registry.setOrgId("acct_a", "org_server00000000000000000")).rejects.toMatchObject({
      code: "not-bound",
    })
  })
})
