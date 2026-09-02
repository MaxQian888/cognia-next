jest.mock("./refresh", () => ({
  refreshCollabPlaneQuietly: jest.fn(async () => ({ status: "refreshed" })),
}))

import { refreshCollabPlaneQuietly } from "./refresh"
import {
  changeOrgRole,
  changeWorkspaceRole,
  inviteToOrg,
  inviteToWorkspace,
  listInvitations,
  offboardFromOrg,
  removeFromWorkspace,
  revokeInvitation,
  type MembershipAdminClient,
} from "./membership-admin"
import { CollabError } from "./client"
import type { CurrentCollabContext } from "./runtime-client"

const ORG = "org_acme00000000000000000"

function stubClient(overrides: Partial<MembershipAdminClient> = {}) {
  const issued = {
    id: "inv_1",
    orgId: ORG,
    createdBy: "usr_ada",
    expiresAt: 10,
    createdAt: 1,
    token: "one-time",
  }
  return {
    createInvitation: jest.fn(async () => issued),
    listInvitations: jest.fn(async () => [issued]),
    revokeInvitation: jest.fn(async () => ({ ...issued, revokedAt: 2 })),
    setWorkspaceMember: jest.fn(async () => undefined),
    removeWorkspaceMember: jest.fn(async () => undefined),
    setOrgMemberRole: jest.fn(async () => undefined),
    offboardOrgMember: jest.fn(async () => undefined),
    ...overrides,
  }
}

function context(client: ReturnType<typeof stubClient>): CurrentCollabContext {
  return {
    localAccountId: "acct_a",
    orgId: ORG,
    userId: "usr_ada",
    client: client as unknown as CurrentCollabContext["client"],
  }
}

describe("membership administration", () => {
  it("shapes a workspace invitation and passes the token straight through", async () => {
    const client = stubClient()
    const issued = await inviteToWorkspace(context(client), {
      workspaceId: "proj_1",
      role: "viewer",
      reason: "review access",
      expiresInDays: 1,
    })
    expect(issued.token).toBe("one-time")
    expect(client.createInvitation).toHaveBeenCalledWith(ORG, {
      workspaceId: "proj_1",
      workspaceRole: "viewer",
      reason: "review access",
      expiresInDays: 1,
    })
  })

  it("leaves the expiry to the server when the caller does not choose one", async () => {
    const client = stubClient()
    await inviteToOrg(context(client), { role: "member", reason: "hire" })
    expect(client.createInvitation).toHaveBeenCalledWith(ORG, { orgRole: "member", reason: "hire" })
  })

  /**
   * The projection is a mirror with one writer. A role change here is a
   * server call followed by a refresh, and nothing else.
   */
  it("follows every membership write with a refresh of the projection", async () => {
    const client = stubClient()
    const refresh = jest.fn(async () => null)
    const ctx = context(client)
    await changeWorkspaceRole(
      ctx,
      { workspaceId: "proj_1", userId: "usr_cleo", role: "maintainer", reason: "lead" },
      { refresh }
    )
    await removeFromWorkspace(ctx, { workspaceId: "proj_1", userId: "usr_cleo" }, { refresh })
    await changeOrgRole(ctx, { userId: "usr_cleo", role: "admin", reason: "promoted" }, { refresh })
    await offboardFromOrg(ctx, { userId: "usr_cleo", reason: "left" }, { refresh })

    expect(client.setWorkspaceMember).toHaveBeenCalledWith(ORG, "proj_1", "usr_cleo", {
      role: "maintainer",
      reason: "lead",
    })
    expect(client.removeWorkspaceMember).toHaveBeenCalledWith(ORG, "proj_1", "usr_cleo", undefined)
    expect(client.setOrgMemberRole).toHaveBeenCalledWith(ORG, "usr_cleo", {
      role: "admin",
      reason: "promoted",
    })
    expect(client.offboardOrgMember).toHaveBeenCalledWith(ORG, "usr_cleo", "left")
    expect(refresh).toHaveBeenCalledTimes(4)
    expect(refresh).toHaveBeenCalledWith("acct_a")
  })

  it("surfaces a refused write as the server's error and skips the refresh", async () => {
    const client = stubClient({
      setOrgMemberRole: jest.fn(async () => {
        throw new CollabError(403, "only an owner may do that")
      }),
    })
    const refresh = jest.fn(async () => null)
    await expect(
      changeOrgRole(
        context(client),
        { userId: "usr_cleo", role: "owner", reason: "x" },
        { refresh }
      )
    ).rejects.toMatchObject({ status: 403 })
    expect(refresh).not.toHaveBeenCalled()
  })

  /**
   * Production passes no `refresh`. The default is the quiet plane refresh,
   * keyed by the profile, and this is the only test that runs that branch.
   */
  it("refreshes through the quiet plane refresh when nothing is injected", async () => {
    const client = stubClient()
    await changeOrgRole(context(client), { userId: "usr_cleo", role: "admin", reason: "promoted" })
    expect(refreshCollabPlaneQuietly).toHaveBeenCalledWith({ localAccountId: "acct_a" })
  })

  it("lists invitations straight from the server", async () => {
    const client = stubClient()
    const rows = await listInvitations(context(client))
    expect(rows.map((row) => row.id)).toEqual(["inv_1"])
    expect(client.listInvitations).toHaveBeenCalledWith(ORG)
  })

  it("revokes an invitation without touching the roster", async () => {
    const client = stubClient()
    const revoked = await revokeInvitation(context(client), "inv_1", "sent to the wrong person")
    expect(revoked.revokedAt).toBe(2)
    expect(client.revokeInvitation).toHaveBeenCalledWith(ORG, "inv_1", "sent to the wrong person")
  })
})
