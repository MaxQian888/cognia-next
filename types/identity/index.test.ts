import {
  ORG_ROLES,
  generateOrgId,
  generateUserId,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_ROLES,
  allowsCapability,
  canTraverseWorkspaces,
  capabilityForRole,
  externalIdentityId,
  isOrgId,
  isUserId,
  orgMembershipId,
  resolveWorkspaceAccess,
  workspaceMembershipId,
  type OrgRole,
  type WorkspaceRole,
} from "./index"

describe("id shapes", () => {
  it("accepts the ADR-0149 prefixes and rejects the ones it replaced", () => {
    expect(isUserId("usr_9f2c1a")).toBe(true)
    expect(isOrgId("org_9f2c1a")).toBe(true)
    // The four things "account" used to mean are not users.
    expect(isUserId("acct_9f2c1a")).toBe(false)
    expect(isUserId("tnt_9f2c1a")).toBe(false)
    expect(isOrgId("tnt_9f2c1a")).toBe(false)
    expect(isUserId("usr_")).toBe(false)
    expect(isUserId("usr_ab")).toBe(false)
    // Three after the prefix is the floor — a real short id must still pass.
    expect(isUserId("usr_ada")).toBe(true)
  })

  it("mints ids that pass its own validators", () => {
    expect(isUserId(generateUserId())).toBe(true)
    expect(isOrgId(generateOrgId())).toBe(true)
    expect(generateUserId()).not.toBe(generateUserId())
    expect(isOrgId(generateUserId())).toBe(false)
  })

  it("derives join keys deterministically, so a re-invite cannot duplicate a row", () => {
    expect(orgMembershipId("org_a", "usr_b")).toBe("org_a:usr_b")
    expect(orgMembershipId("org_a", "usr_b")).toBe(orgMembershipId("org_a", "usr_b"))
    expect(workspaceMembershipId("proj_1", "usr_b")).toBe("proj_1:usr_b")
    expect(externalIdentityId("logto", "sub_1")).toBe("logto::sub_1")
    expect(externalIdentityId("lark", "ou_1", "tenant_9")).toBe("lark:tenant_9:ou_1")
  })

  it("keeps two providers' identical subjects apart", () => {
    expect(externalIdentityId("lark", "x")).not.toBe(externalIdentityId("slack", "x"))
    expect(externalIdentityId("lark", "x", "t1")).not.toBe(externalIdentityId("lark", "x", "t2"))
  })
})

describe("role vocabulary", () => {
  it("ranks capabilities so a check is a comparison", () => {
    expect(capabilityForRole("maintainer")).toBe("manage")
    expect(capabilityForRole("member")).toBe("write")
    expect(capabilityForRole("viewer")).toBe("read")
  })

  it("covers every declared role, so a new one cannot resolve to undefined", () => {
    for (const role of WORKSPACE_ROLES) {
      expect(WORKSPACE_CAPABILITIES).toContain(capabilityForRole(role))
    }
  })

  it("lets owner and admin traverse workspaces, and nobody else", () => {
    expect(canTraverseWorkspaces("owner")).toBe(true)
    expect(canTraverseWorkspaces("admin")).toBe(true)
    expect(canTraverseWorkspaces("member")).toBe(false)
    expect(ORG_ROLES).toEqual(["owner", "admin", "member"])
  })
})

describe("resolveWorkspaceAccess — the two-tier collapse", () => {
  const member = (role: WorkspaceRole) => ({ role })
  const org = (role: OrgRole) => ({ role })

  it("grants nothing for Org membership alone — recruitment is independent", () => {
    expect(resolveWorkspaceAccess({ orgMembership: org("member") })).toBeNull()
  })

  it("grants nothing at all to someone in neither layer", () => {
    expect(resolveWorkspaceAccess({})).toBeNull()
    expect(resolveWorkspaceAccess({ orgMembership: null, workspaceMembership: null })).toBeNull()
  })

  it("lets an Org admin traverse in, as a maintainer, and records how", () => {
    expect(resolveWorkspaceAccess({ orgMembership: org("admin") })).toEqual({
      role: "maintainer",
      capability: "manage",
      via: "org-admin",
      guest: false,
    })
    expect(resolveWorkspaceAccess({ orgMembership: org("owner") })?.via).toBe("org-admin")
  })

  it("lets a direct membership win over org-admin traversal, downgrade included", () => {
    // Deliberately made a viewer here: the explicit role is what an audit log
    // must show, and an admin who was narrowed stays narrowed.
    const access = resolveWorkspaceAccess({
      orgMembership: org("admin"),
      workspaceMembership: member("viewer"),
    })
    expect(access).toMatchObject({ role: "viewer", capability: "read", via: "membership" })
  })

  it("derives guest from the absence of Org membership, never from a flag", () => {
    expect(resolveWorkspaceAccess({ workspaceMembership: member("member") })).toMatchObject({
      via: "membership",
      guest: true,
    })
    expect(
      resolveWorkspaceAccess({
        orgMembership: org("member"),
        workspaceMembership: member("member"),
      })
    ).toMatchObject({ guest: false })
  })

  it("never produces a guest who traversed in — that combination cannot exist", () => {
    for (const orgRole of ORG_ROLES) {
      const access = resolveWorkspaceAccess({ orgMembership: org(orgRole) })
      if (access) expect(access.guest).toBe(false)
    }
  })
})

describe("allowsCapability", () => {
  it("treats no access as no capability", () => {
    for (const capability of WORKSPACE_CAPABILITIES) {
      expect(allowsCapability(null, capability)).toBe(false)
    }
  })

  it("clears every bar at or below the granted one", () => {
    const maintainer = resolveWorkspaceAccess({ workspaceMembership: { role: "maintainer" } })
    expect(allowsCapability(maintainer, "read")).toBe(true)
    expect(allowsCapability(maintainer, "write")).toBe(true)
    expect(allowsCapability(maintainer, "manage")).toBe(true)

    const viewer = resolveWorkspaceAccess({ workspaceMembership: { role: "viewer" } })
    expect(allowsCapability(viewer, "read")).toBe(true)
    expect(allowsCapability(viewer, "write")).toBe(false)
    expect(allowsCapability(viewer, "manage")).toBe(false)
  })

  it("does not let a guest's role be quietly upgraded by their guest-ness", () => {
    const guest = resolveWorkspaceAccess({ workspaceMembership: { role: "viewer" } })
    expect(guest?.guest).toBe(true)
    expect(allowsCapability(guest, "write")).toBe(false)
  })
})
