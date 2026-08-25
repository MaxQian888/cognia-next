import {
  findUserIdByExternalIdentity,
  getUser,
  linkExternalIdentity,
  listExternalIdentities,
  upsertUser,
} from "@/lib/db/identity"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { isUserId } from "@/types/identity"

import {
  ExternalPersonError,
  findExternalPerson,
  resolveExternalPerson,
  type ExternalSubject,
} from "./external-person"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  const db = getDb()
  await Promise.all([db.users.clear(), db.externalIdentities.clear()])
})
afterAll(dbFixture.dispose)

const OPEN: ExternalSubject = { provider: "lark", subject: "ou_ada", tenant: "tk_1/app_1" }
const UNION: ExternalSubject = { provider: "lark", subject: "on_ada", tenant: "tk_1" }
const LOGTO_SUB: ExternalSubject = { provider: "logto", subject: "logto_ada" }

describe("resolveExternalPerson", () => {
  it("mints a person the first time and files every tenanted subject under them", async () => {
    const result = await resolveExternalPerson({
      subjects: [UNION, OPEN],
      displayName: "Ada",
      now: 100,
    })

    expect(result.created).toBe(true)
    expect(isUserId(result.userId)).toBe(true)
    expect(result.matched).toBeUndefined()
    expect(result.linked).toHaveLength(2)

    const user = await getUser(result.userId)
    expect(user).toMatchObject({ displayName: "Ada", createdAt: 100, updatedAt: 100 })
    expect(await listExternalIdentities(result.userId)).toHaveLength(2)
  })

  it("finds the same person on a second call and links nothing new", async () => {
    const first = await resolveExternalPerson({
      subjects: [UNION, OPEN],
      displayName: "Ada",
      now: 100,
    })
    const second = await resolveExternalPerson({
      subjects: [UNION, OPEN],
      displayName: "Ada (renamed)",
      now: 200,
    })

    expect(second.userId).toBe(first.userId)
    expect(second.created).toBe(false)
    expect(second.matched).toEqual(UNION)
    expect(second.linked).toEqual([])
    // The label is set at link time; a repeat resolution must not rewrite the
    // row, or `linkedAt` would move every time somebody sends a message.
    const rows = await listExternalIdentities(first.userId)
    expect(rows.every((row) => row.linkedAt === 100)).toBe(true)
  })

  it("honours the caller's ranking — the strongest subject wins the match", async () => {
    // Two people: the union id names Ada, the open id names Bob. A caller that
    // ranks the union id first is saying "trust the key that survives an app
    // change", and resolution must obey rather than take whichever it finds.
    await upsertUser({ id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 })
    await upsertUser({ id: "usr_bob", displayName: "Bob", createdAt: 1, updatedAt: 1 })
    await linkExternalIdentity({ userId: "usr_ada", ...UNION, now: 1 })
    await linkExternalIdentity({ userId: "usr_bob", ...OPEN, now: 1 })

    const result = await resolveExternalPerson({
      subjects: [UNION, OPEN],
      displayName: "unused",
      now: 300,
    })

    expect(result.userId).toBe("usr_ada")
    expect(result.matched).toEqual(UNION)
  })

  it("never re-points a subject that already belongs to somebody else", async () => {
    await upsertUser({ id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 })
    await upsertUser({ id: "usr_bob", displayName: "Bob", createdAt: 1, updatedAt: 1 })
    await linkExternalIdentity({ userId: "usr_ada", ...UNION, now: 1 })
    await linkExternalIdentity({ userId: "usr_bob", ...OPEN, now: 1 })

    await resolveExternalPerson({ subjects: [UNION, OPEN], displayName: "unused", now: 300 })

    // Bob keeps his open id. Merging two people is an operator decision, and
    // an automatic path that silently moved it would attribute Bob's messages
    // to Ada.
    expect(await findUserIdByExternalIdentity("lark", OPEN.subject, OPEN.tenant)).toBe("usr_bob")
  })

  it("matches an untenanted subject across tenants without ever filing one", async () => {
    await upsertUser({ id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 })
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "logto",
      subject: "logto_ada",
      tenant: "https://logto.example.com/oidc",
      now: 1,
    })

    const result = await resolveExternalPerson({
      subjects: [LOGTO_SUB, OPEN],
      displayName: "Ada from Lark",
      now: 400,
    })

    // The IM plane knows the `logtoSubject` but not which Logto issued it.
    // That is enough to recognise the person...
    expect(result.userId).toBe("usr_ada")
    expect(result.created).toBe(false)
    // ...and the Lark id joins them, while the untenanted logto subject writes
    // nothing: its computed id would not be the one the sign-in writer uses.
    expect(result.linked).toEqual([OPEN])
    const rows = await listExternalIdentities("usr_ada")
    expect(rows.map((row) => row.id).sort()).toEqual(
      ["lark:tk_1/app_1:ou_ada", "logto:https://logto.example.com/oidc:logto_ada"].sort()
    )
  })

  it("refuses an ambiguous untenanted subject rather than picking a person", async () => {
    await upsertUser({ id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 })
    await upsertUser({ id: "usr_bob", displayName: "Bob", createdAt: 1, updatedAt: 1 })
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "logto",
      subject: "logto_shared",
      tenant: "https://one.example/oidc",
      now: 1,
    })
    await linkExternalIdentity({
      userId: "usr_bob",
      provider: "logto",
      subject: "logto_shared",
      tenant: "https://two.example/oidc",
      now: 1,
    })

    const result = await resolveExternalPerson({
      subjects: [{ provider: "logto", subject: "logto_shared" }, OPEN],
      displayName: "Someone",
      now: 500,
    })

    // Two deployments minted the same `sub` for two humans. Neither is the
    // answer, so a NEW person is minted rather than one of them chosen.
    expect(result.created).toBe(true)
    expect(result.userId).not.toBe("usr_ada")
    expect(result.userId).not.toBe("usr_bob")
  })

  it("refuses to mint a person nothing could ever find again", async () => {
    await expect(
      resolveExternalPerson({ subjects: [LOGTO_SUB], displayName: "Ada" })
    ).rejects.toMatchObject({ name: "ExternalPersonError", code: "no-linkable-subject" })

    await expect(
      resolveExternalPerson({ subjects: [], displayName: "Ada" })
    ).rejects.toBeInstanceOf(ExternalPersonError)

    expect(await getDb().users.count()).toBe(0)
  })
})

describe("findExternalPerson", () => {
  it("answers without creating anything", async () => {
    expect(await findExternalPerson([OPEN])).toBeUndefined()
    expect(await getDb().users.count()).toBe(0)

    await upsertUser({ id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 })
    await linkExternalIdentity({ userId: "usr_ada", ...OPEN, now: 1 })

    expect(await findExternalPerson([UNION, OPEN])).toEqual({
      userId: "usr_ada",
      matched: OPEN,
    })
  })
})
