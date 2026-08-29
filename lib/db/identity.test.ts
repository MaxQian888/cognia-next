import {
  findUserIdByExternalIdentity,
  findUserIdByProviderSubject,
  listWorkspaceRoster,
  replaceWorkspaceRoster,
  resolvePersonStanding,
  getOrg,
  getOrgMembership,
  getUser,
  getWorkspaceMembership,
  linkExternalIdentity,
  listExternalIdentities,
  listOrgMembers,
  listOrgsForUser,
  listUsers,
  listWorkspaceMembers,
  listWorkspacesForUser,
  putOrgMembership,
  putWorkspaceMembership,
  removeOrgMembership,
  removeWorkspaceMembership,
  resolveWorkspaceAccessFor,
  unlinkExternalIdentity,
  upsertOrg,
  upsertUser,
} from "./identity"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  const db = getDb()
  await Promise.all([
    db.users.clear(),
    db.orgs.clear(),
    db.orgMemberships.clear(),
    db.workspaceMemberships.clear(),
    db.externalIdentities.clear(),
  ])
})
afterAll(dbFixture.dispose)

const ada = { id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 }
const bob = { id: "usr_bob", displayName: "Bob", createdAt: 1, updatedAt: 1 }
const acme = { id: "org_acme", displayName: "Acme", createdAt: 1, updatedAt: 1 }

describe("users and orgs", () => {
  it("upserts and reads back", async () => {
    await upsertUser(ada)
    await upsertOrg(acme)
    expect(await getUser("usr_ada")).toMatchObject({ displayName: "Ada" })
    expect(await getOrg("org_acme")).toMatchObject({ displayName: "Acme" })
    expect(await getUser("usr_nobody")).toBeUndefined()
  })

  it("bulk-reads only the people that exist, without holes in the array", async () => {
    await upsertUser(ada)
    expect(await listUsers([])).toEqual([])
    expect((await listUsers(["usr_ada", "usr_ghost"])).map((u) => u.id)).toEqual(["usr_ada"])
  })
})

describe("org membership", () => {
  it("keys on the pair, so re-inviting updates instead of duplicating", async () => {
    const first = await putOrgMembership({
      orgId: "org_acme",
      userId: "usr_ada",
      role: "member",
      now: 10,
    })
    const second = await putOrgMembership({
      orgId: "org_acme",
      userId: "usr_ada",
      role: "admin",
      now: 20,
    })

    expect(second.id).toBe(first.id)
    expect(second.role).toBe("admin")
    expect(second.createdAt).toBe(10)
    expect(second.updatedAt).toBe(20)
    expect(await listOrgMembers("org_acme")).toHaveLength(1)
  })

  it("reads in both directions", async () => {
    await putOrgMembership({ orgId: "org_acme", userId: "usr_ada", role: "owner" })
    await putOrgMembership({ orgId: "org_acme", userId: "usr_bob", role: "member" })
    await putOrgMembership({ orgId: "org_other", userId: "usr_ada", role: "member" })

    expect((await listOrgMembers("org_acme")).map((m) => m.userId).sort()).toEqual([
      "usr_ada",
      "usr_bob",
    ])
    expect((await listOrgsForUser("usr_ada")).map((m) => m.orgId).sort()).toEqual([
      "org_acme",
      "org_other",
    ])
  })

  it("removes exactly one pair", async () => {
    await putOrgMembership({ orgId: "org_acme", userId: "usr_ada", role: "member" })
    await putOrgMembership({ orgId: "org_acme", userId: "usr_bob", role: "member" })
    await removeOrgMembership("org_acme", "usr_ada")
    expect(await getOrgMembership("org_acme", "usr_ada")).toBeUndefined()
    expect(await getOrgMembership("org_acme", "usr_bob")).toBeDefined()
  })
})

describe("workspace membership", () => {
  it("narrows to one org through the compound index", async () => {
    await putWorkspaceMembership({
      workspaceId: "proj_1",
      orgId: "org_acme",
      userId: "usr_ada",
      role: "member",
    })
    await putWorkspaceMembership({
      workspaceId: "proj_2",
      orgId: "org_acme",
      userId: "usr_ada",
      role: "viewer",
    })
    await putWorkspaceMembership({
      workspaceId: "proj_3",
      orgId: "org_other",
      userId: "usr_ada",
      role: "maintainer",
    })

    expect((await listWorkspacesForUser("usr_ada")).map((m) => m.workspaceId).sort()).toEqual([
      "proj_1",
      "proj_2",
      "proj_3",
    ])
    expect(
      (await listWorkspacesForUser("usr_ada", "org_acme")).map((m) => m.workspaceId).sort()
    ).toEqual(["proj_1", "proj_2"])
  })

  it("lists a workspace's roster and removes one seat", async () => {
    await putWorkspaceMembership({
      workspaceId: "proj_1",
      orgId: "org_acme",
      userId: "usr_ada",
      role: "maintainer",
    })
    await putWorkspaceMembership({
      workspaceId: "proj_1",
      orgId: "org_acme",
      userId: "usr_bob",
      role: "viewer",
    })
    expect(await listWorkspaceMembers("proj_1")).toHaveLength(2)

    await removeWorkspaceMembership("proj_1", "usr_bob")
    expect(await getWorkspaceMembership("proj_1", "usr_bob")).toBeUndefined()
    expect(await getWorkspaceMembership("proj_1", "usr_ada")).toBeDefined()
  })
})

describe("external identities", () => {
  it("is idempotent on provider, tenant and subject", async () => {
    await linkExternalIdentity({ userId: "usr_ada", provider: "logto", subject: "sub_1" })
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "logto",
      subject: "sub_1",
      label: "Ada",
    })
    const rows = await listExternalIdentities("usr_ada")
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe("Ada")
  })

  it("re-links a subject to a different person as an update, not a second row", async () => {
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "lark",
      subject: "ou_1",
      tenant: "t1",
    })
    await linkExternalIdentity({
      userId: "usr_bob",
      provider: "lark",
      subject: "ou_1",
      tenant: "t1",
    })

    expect(await findUserIdByExternalIdentity("lark", "ou_1", "t1")).toBe("usr_bob")
    expect(await listExternalIdentities("usr_ada")).toHaveLength(0)
    expect(await listExternalIdentities("usr_bob")).toHaveLength(1)
  })

  it("keeps the same subject in two tenants apart", async () => {
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "lark",
      subject: "ou_1",
      tenant: "t1",
    })
    await linkExternalIdentity({
      userId: "usr_bob",
      provider: "lark",
      subject: "ou_1",
      tenant: "t2",
    })
    expect(await findUserIdByExternalIdentity("lark", "ou_1", "t1")).toBe("usr_ada")
    expect(await findUserIdByExternalIdentity("lark", "ou_1", "t2")).toBe("usr_bob")
  })

  it("returns undefined for a subject nobody claimed, and unlinks", async () => {
    expect(await findUserIdByExternalIdentity("github", "octocat")).toBeUndefined()
    await linkExternalIdentity({ userId: "usr_ada", provider: "github", subject: "octocat" })
    await unlinkExternalIdentity("github", "octocat")
    expect(await findUserIdByExternalIdentity("github", "octocat")).toBeUndefined()
  })
})

describe("resolveWorkspaceAccessFor", () => {
  it("grants nothing on org membership alone", async () => {
    await putOrgMembership({ orgId: "org_acme", userId: "usr_ada", role: "member" })
    expect(
      await resolveWorkspaceAccessFor({
        userId: "usr_ada",
        orgId: "org_acme",
        workspaceId: "proj_1",
      })
    ).toBeNull()
  })

  it("lets an org admin traverse, and marks how they got in", async () => {
    await putOrgMembership({ orgId: "org_acme", userId: "usr_ada", role: "admin" })
    expect(
      await resolveWorkspaceAccessFor({
        userId: "usr_ada",
        orgId: "org_acme",
        workspaceId: "proj_1",
      })
    ).toMatchObject({ via: "org-admin", capability: "manage", guest: false })
  })

  it("reports a workspace member with no org membership as a guest", async () => {
    await putWorkspaceMembership({
      workspaceId: "proj_1",
      orgId: "org_acme",
      userId: "usr_bob",
      role: "member",
    })
    expect(
      await resolveWorkspaceAccessFor({
        userId: "usr_bob",
        orgId: "org_acme",
        workspaceId: "proj_1",
      })
    ).toMatchObject({ via: "membership", role: "member", guest: true })
  })

  it("keeps org-admin management as the workspace permission floor", async () => {
    await putOrgMembership({ orgId: "org_acme", userId: "usr_ada", role: "admin" })
    await putWorkspaceMembership({
      workspaceId: "proj_1",
      orgId: "org_acme",
      userId: "usr_ada",
      role: "viewer",
    })
    expect(
      await resolveWorkspaceAccessFor({
        userId: "usr_ada",
        orgId: "org_acme",
        workspaceId: "proj_1",
      })
    ).toMatchObject({ via: "org-admin", role: "maintainer", capability: "manage" })
  })

  it("gives a stranger nothing", async () => {
    await upsertUser(bob)
    expect(
      await resolveWorkspaceAccessFor({
        userId: "usr_bob",
        orgId: "org_acme",
        workspaceId: "proj_1",
      })
    ).toBeNull()
  })
})

describe("findUserIdByProviderSubject", () => {
  it("finds a subject whose tenant the caller does not know", async () => {
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "logto",
      subject: "logto_ada",
      tenant: "https://logto.example.com/oidc",
      now: 1,
    })

    // The deterministic id encodes the tenant, so the tenant-aware read cannot
    // answer this — and the IM plane holds a `logtoSubject` without an issuer.
    expect(await findUserIdByExternalIdentity("logto", "logto_ada")).toBeUndefined()
    expect(await findUserIdByProviderSubject("logto", "logto_ada")).toBe("usr_ada")
  })

  it("does not cross providers", async () => {
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "lark",
      subject: "shared",
      tenant: "tk_1",
      now: 1,
    })
    expect(await findUserIdByProviderSubject("logto", "shared")).toBeUndefined()
    expect(await findUserIdByProviderSubject("lark", "shared")).toBe("usr_ada")
  })

  it("refuses rather than picking when one subject names two people", async () => {
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "logto",
      subject: "collide",
      tenant: "https://one.example/oidc",
      now: 1,
    })
    await linkExternalIdentity({
      userId: "usr_bob",
      provider: "logto",
      subject: "collide",
      tenant: "https://two.example/oidc",
      now: 1,
    })

    expect(await findUserIdByProviderSubject("logto", "collide")).toBeUndefined()
  })

  it("still answers when one person holds the same subject in two tenants", async () => {
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "lark",
      subject: "on_ada",
      tenant: "tk_1",
      now: 1,
    })
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "lark",
      subject: "on_ada",
      tenant: "tk_2",
      now: 1,
    })

    // Two rows, one person — not ambiguous.
    expect(await findUserIdByProviderSubject("lark", "on_ada")).toBe("usr_ada")
  })
})

describe("resolvePersonStanding", () => {
  it("reads org-member, guest and unaffiliated off the membership rows", async () => {
    await putOrgMembership({ orgId: "org_acme", userId: "usr_ada", role: "member", now: 1 })
    await putWorkspaceMembership({
      workspaceId: "proj_1",
      orgId: "org_acme",
      userId: "usr_bob",
      role: "viewer",
      now: 1,
    })

    expect(await resolvePersonStanding("usr_ada")).toBe("org-member")
    expect(await resolvePersonStanding("usr_bob")).toBe("guest")
    // The state a freshly-bound IM sender is in, and saying so is the point.
    expect(await resolvePersonStanding("usr_stranger")).toBe("unaffiliated")
  })

  it("calls somebody with both memberships an org member, not a guest", async () => {
    await putOrgMembership({ orgId: "org_acme", userId: "usr_ada", role: "member", now: 1 })
    await putWorkspaceMembership({
      workspaceId: "proj_1",
      orgId: "org_acme",
      userId: "usr_ada",
      role: "member",
      now: 1,
    })
    expect(await resolvePersonStanding("usr_ada")).toBe("org-member")
  })
})

describe("workspace roster", () => {
  const ORG = "org_acme"
  const WORKSPACE = "proj_1"

  it("marks the member without Org membership as a guest", async () => {
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada", role: "maintainer", orgMember: true },
        { userId: "usr_bob", displayName: "Bob", role: "viewer", orgMember: false },
      ],
      now: 1,
    })

    const roster = await listWorkspaceRoster(WORKSPACE)
    expect(roster.map((entry) => [entry.user?.displayName, entry.guest])).toEqual([
      ["Ada", false],
      ["Bob", true],
    ])
  })

  it("stops calling somebody a guest the moment they join the Org", async () => {
    // Derived on every read, so a promotion needs no second write. A stored
    // flag would still say "guest" here.
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [{ userId: "usr_bob", displayName: "Bob", role: "viewer", orgMember: false }],
      now: 1,
    })
    expect((await listWorkspaceRoster(WORKSPACE))[0]?.guest).toBe(true)

    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [{ userId: "usr_bob", displayName: "Bob", role: "viewer", orgMember: true }],
      now: 2,
    })
    expect((await listWorkspaceRoster(WORKSPACE))[0]?.guest).toBe(false)
  })

  it("does not demote an existing org role to `member`", async () => {
    // The roster reports THAT somebody is in the org, not with which role.
    // Writing `member` over an owner is a demotion nobody asked for.
    await putOrgMembership({ orgId: ORG, userId: "usr_ada", role: "owner", now: 1 })
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [{ userId: "usr_ada", displayName: "Ada", role: "member", orgMember: true }],
      now: 2,
    })
    expect((await getOrgMembership(ORG, "usr_ada"))?.role).toBe("owner")
  })

  it("drops somebody the roster no longer lists, and only in that workspace", async () => {
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada", role: "member", orgMember: true },
        { userId: "usr_bob", displayName: "Bob", role: "viewer", orgMember: false },
      ],
      now: 1,
    })
    await replaceWorkspaceRoster({
      workspaceId: "proj_2",
      orgId: ORG,
      members: [{ userId: "usr_bob", displayName: "Bob", role: "viewer", orgMember: false }],
      now: 1,
    })

    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [{ userId: "usr_ada", displayName: "Ada", role: "member", orgMember: true }],
      now: 2,
    })

    expect(await listWorkspaceRoster(WORKSPACE)).toHaveLength(1)
    // The other workspace was never mentioned, so it was not touched.
    expect(await listWorkspaceRoster("proj_2")).toHaveLength(1)
  })

  it("keeps a person's email and creation time across a roster refresh", async () => {
    // The roster carries a display name and nothing else; overwriting the rest
    // of the person with blanks would lose what sign-in learned.
    await upsertUser({
      id: "usr_ada",
      displayName: "Ada",
      email: "ada@example.dev",
      createdAt: 5,
      updatedAt: 5,
    })
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada Lovelace", role: "member", orgMember: true },
      ],
      now: 9,
    })

    const user = await getUser("usr_ada")
    expect(user).toMatchObject({
      displayName: "Ada Lovelace",
      email: "ada@example.dev",
      createdAt: 5,
    })
  })

  it("is empty for a workspace nobody was recruited into", async () => {
    expect(await listWorkspaceRoster("proj_empty")).toEqual([])
  })
})
