/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { putOrgMembership, putWorkspaceMembership } from "@/lib/db/identity"
import { CollabError } from "@/lib/collab/client"
import { parseOrgCapabilities, type OrgCapabilitiesResult } from "@/lib/collab/capabilities"
import { notifyCollabScopeChanged } from "@/lib/collab/scope-events"
import { __resetOrgCapabilitiesCacheForTesting } from "@/hooks/collab/use-org-capabilities"
import type { CurrentCollabContext } from "@/lib/collab/runtime-client"
import type { UserBindingRegistry } from "@/lib/identity/user-binding"
import type { UserBindingRow } from "@/lib/accounts/account-db"

import {
  MembershipAdminError,
  describeAdminError,
  membershipFailureMessage,
  toMembershipAdminFailure,
  useMembershipAdmin,
  type UseMembershipAdminDeps,
} from "./use-membership-admin"

const ORG = "org_acme"
const WORKSPACE = "proj_1"
const ADA = "usr_ada"

function stubClient() {
  return {
    createInvitation: jest.fn(async () => ({
      id: "inv_1",
      orgId: ORG,
      createdBy: ADA,
      expiresAt: 10,
      createdAt: 1,
      token: "one-time",
    })),
    setWorkspaceMember: jest.fn(async () => undefined),
    removeWorkspaceMember: jest.fn(async () => undefined),
    setOrgMemberRole: jest.fn(async () => undefined),
    offboardOrgMember: jest.fn(async () => undefined),
    transferOrgOwnership: jest.fn(async () => undefined),
    listInvitations: jest.fn(async () => [
      { id: "inv_1", orgId: ORG, createdBy: ADA, expiresAt: 10, createdAt: 1 },
    ]),
    revokeInvitation: jest.fn(async () => ({
      id: "inv_1",
      orgId: ORG,
      createdBy: ADA,
      expiresAt: 10,
      createdAt: 1,
      revokedAt: 5,
    })),
  }
}

function contextFor(client: ReturnType<typeof stubClient>): CurrentCollabContext {
  return {
    localAccountId: "acct_a",
    orgId: ORG,
    userId: ADA,
    client: client as unknown as CurrentCollabContext["client"],
  }
}

const registryWith = (
  binding: { userId: string; orgId?: string; legacyUserIds?: string[] } | null
): Pick<UserBindingRegistry, "get"> => ({
  get: async () => (binding ? ({ ...binding } as UserBindingRow) : null),
})

/**
 * Deps are built once per test and passed by reference, the way the members
 * component passes them from props. A fresh object on every render would
 * re-resolve the context each time, which is a caller bug and not the hook's.
 */
function render(workspaceId: string | null, deps: UseMembershipAdminDeps) {
  return renderHook(() => useMembershipAdmin(workspaceId, deps))
}

function serverSays(actions: string[]): OrgCapabilitiesResult {
  return {
    status: "ready",
    capabilities: parseOrgCapabilities(
      {
        schemaVersion: 1,
        orgId: ORG,
        workspaceId: WORKSPACE,
        standing: { orgRole: "member", workspaceRole: "member", via: "membership", guest: false },
        actions,
        features: [],
        evaluatedAt: 1,
      },
      { orgId: ORG, workspaceId: WORKSPACE }
    ),
  }
}

describe("useMembershipAdmin", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetOrgCapabilitiesCacheForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("is unavailable with the reason when nobody is signed in", async () => {
    const { result } = render(WORKSPACE, {
      resolveContext: async () => null,
      registry: registryWith(null),
    })
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.reason).toBe("not-signed-in")
    expect(result.current.canManageWorkspace).toBe(false)
  })

  it("distinguishes a sign-in with no org from a missing server", async () => {
    const { result } = render(WORKSPACE, {
      resolveContext: async () => null,
      registry: registryWith({ userId: ADA }),
    })
    await waitFor(() => expect(result.current.reason).toBe("no-org"))

    const configured = render(WORKSPACE, {
      resolveContext: async () => null,
      registry: registryWith({ userId: ADA, orgId: ORG }),
    })
    await waitFor(() => expect(configured.result.current.reason).toBe("not-configured"))
  })

  /**
   * The affordance comes from the projection: a maintainer of the workspace
   * who is also an org admin may manage both. A plain member may manage
   * neither, whatever the server would say.
   */
  it("derives what may be managed from the local projection", async () => {
    await putOrgMembership({ orgId: ORG, userId: ADA, role: "admin", now: 1 })
    await putWorkspaceMembership({
      workspaceId: WORKSPACE,
      orgId: ORG,
      userId: ADA,
      role: "maintainer",
      now: 1,
    })
    const client = stubClient()
    const { result } = render(WORKSPACE, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG, legacyUserIds: ["usr_old"] }),
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await waitFor(() => expect(result.current.canManageWorkspace).toBe(true))
    expect(result.current.canManageOrg).toBe(true)
    expect(result.current.orgRole).toBe("admin")
    // The reader is every id the binding remembers, not only the canonical one.
    expect(result.current.selfUserIds).toEqual([ADA, "usr_old"])
    expect(result.current.selfUserId).toBe(ADA)
  })

  it("reads a resolver that throws as not configured, and keeps the cause", async () => {
    const { result } = render(WORKSPACE, {
      resolveContext: async () => {
        throw new Error("keyring locked")
      },
      registry: registryWith(null),
    })
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.reason).toBe("not-configured")
    expect(result.current.error).toEqual({ kind: "failed", message: "keyring locked" })
  })

  it("refuses workspace-scoped writes without a workspace, without going busy for good", async () => {
    const client = stubClient()
    const { result } = render(null, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG }),
      refresh: async () => null,
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    let caught: unknown
    await act(async () => {
      try {
        await result.current.inviteToWorkspace({ role: "member", reason: "r" })
      } catch (error) {
        caught = error
      }
    })
    expect(caught).toBeInstanceOf(MembershipAdminError)
    expect(result.current.error).toEqual({ kind: "no-workspace" })
    expect(result.current.busy).toBe(false)
    expect(client.createInvitation).not.toHaveBeenCalled()
    // Org-scoped writes do not need one.
    await act(async () => {
      await result.current.inviteToOrg({ role: "member", reason: "hire" })
    })
    expect(client.createInvitation).toHaveBeenCalledWith(ORG, { orgRole: "member", reason: "hire" })
  })

  it("lists and revokes invitations through the client", async () => {
    const client = stubClient()
    const { result } = render(WORKSPACE, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG }),
      refresh: async () => null,
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const rows = await act(() => result.current.listInvitations())
    expect(rows.map((row) => row.id)).toEqual(["inv_1"])
    const revoked = await act(() => result.current.revokeInvitation("inv_1", "wrong person"))
    expect(revoked.revokedAt).toBe(5)
    expect(client.revokeInvitation).toHaveBeenCalledWith(ORG, "inv_1", "wrong person")
  })

  it("a plain member manages nothing", async () => {
    await putOrgMembership({ orgId: ORG, userId: ADA, role: "member", now: 1 })
    await putWorkspaceMembership({
      workspaceId: WORKSPACE,
      orgId: ORG,
      userId: ADA,
      role: "member",
      now: 1,
    })
    const client = stubClient()
    const { result } = render(WORKSPACE, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG }),
    })
    await waitFor(() => expect(result.current.orgRole).toBe("member"))
    expect(result.current.canManageWorkspace).toBe(false)
    expect(result.current.canManageOrg).toBe(false)
  })

  it("lets the server's action list override the projection in both directions", async () => {
    // The projection says plain member; the server says this person manages.
    await putOrgMembership({ orgId: ORG, userId: ADA, role: "member", now: 1 })
    const client = stubClient()
    const grant = render(WORKSPACE, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG }),
      capabilities: {
        fetch: async () =>
          serverSays(["workspace.members.manage", "org.members.manage", "org.ownership.transfer"]),
      },
    })
    await waitFor(() => expect(grant.result.current.capabilities.status).toBe("ready"))
    expect(grant.result.current.canManageWorkspace).toBe(true)
    expect(grant.result.current.canManageOrg).toBe(true)
    expect(grant.result.current.canTransferOwnership).toBe(true)

    // The projection still says owner after a demotion it has not heard of
    // yet; the server's answer takes the controls away.
    __resetOrgCapabilitiesCacheForTesting()
    await putOrgMembership({ orgId: ORG, userId: ADA, role: "owner", now: 2 })
    const revoke = render(WORKSPACE, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG }),
      capabilities: { fetch: async () => serverSays(["workspace.read"]) },
    })
    await waitFor(() => expect(revoke.result.current.capabilities.status).toBe("ready"))
    expect(revoke.result.current.canManageOrg).toBe(false)
    expect(revoke.result.current.canTransferOwnership).toBe(false)
  })

  it("transfers ownership through the client and asks for capabilities again", async () => {
    const client = stubClient()
    const refresh = jest.fn(async () => null)
    const fetch = jest.fn(async () => serverSays(["org.ownership.transfer"]))
    const { result } = render(WORKSPACE, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG }),
      refresh,
      capabilities: { fetch },
    })
    await waitFor(() => expect(result.current.capabilities.status).toBe("ready"))
    const before = fetch.mock.calls.length
    await act(async () => {
      await result.current.transferOwnership({
        toUserId: "usr_cleo",
        previousOwnerRole: "admin",
        reason: "handing over",
      })
    })
    expect(client.transferOrgOwnership).toHaveBeenCalledWith(ORG, {
      toUserId: "usr_cleo",
      previousOwnerRole: "admin",
      reason: "handing over",
    })
    expect(refresh).toHaveBeenCalledWith("acct_a")
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before))
  })

  it("resolves the context again after the profile switches org", async () => {
    const client = stubClient()
    const resolveContext = jest.fn(async () => contextFor(client))
    const deps: UseMembershipAdminDeps = {
      resolveContext,
      registry: registryWith({ userId: ADA, orgId: ORG }),
    }
    const { result } = render(WORKSPACE, deps)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const before = resolveContext.mock.calls.length
    act(() => notifyCollabScopeChanged())
    await waitFor(() => expect(resolveContext.mock.calls.length).toBeGreaterThan(before))
  })

  it("runs a write through the client, refreshes, and clears busy", async () => {
    const client = stubClient()
    const refresh = jest.fn(async () => null)
    const { result } = render(WORKSPACE, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG }),
      refresh,
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => {
      await result.current.changeWorkspaceRole({ userId: "usr_cleo", role: "viewer", reason: "r" })
    })
    expect(client.setWorkspaceMember).toHaveBeenCalledWith(ORG, WORKSPACE, "usr_cleo", {
      role: "viewer",
      reason: "r",
    })
    expect(refresh).toHaveBeenCalledWith("acct_a")
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeNull()

    const issued = await act(() =>
      result.current.inviteToWorkspace({ role: "member", reason: "onboarding" })
    )
    expect(issued.token).toBe("one-time")
    expect(client.createInvitation).toHaveBeenCalledWith(ORG, {
      workspaceId: WORKSPACE,
      workspaceRole: "member",
      reason: "onboarding",
    })
  })

  it("keeps the server's refusal as the error and rethrows it", async () => {
    const client = stubClient()
    client.offboardOrgMember.mockRejectedValueOnce(new CollabError(403, "owners cannot be removed"))
    const { result } = render(WORKSPACE, {
      resolveContext: async () => contextFor(client),
      registry: registryWith({ userId: ADA, orgId: ORG }),
      refresh: async () => null,
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    let caught: unknown
    await act(async () => {
      try {
        await result.current.offboardFromOrg({ userId: "usr_owner" })
      } catch (error) {
        caught = error
      }
    })
    expect(caught).toMatchObject({ status: 403 })
    expect(result.current.error).toEqual({
      kind: "refused",
      status: 403,
      message: "owners cannot be removed",
    })
    expect(result.current.busy).toBe(false)
  })

  it("refuses to act before the plane is available", async () => {
    const { result } = render(WORKSPACE, {
      resolveContext: async () => null,
      registry: registryWith(null),
    })
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    let caught: unknown
    await act(async () => {
      try {
        await result.current.changeOrgRole({ userId: "usr_x", role: "admin", reason: "r" })
      } catch (error) {
        caught = error
      }
    })
    expect(caught).toBeInstanceOf(MembershipAdminError)
    expect((caught as MembershipAdminError).failure).toEqual({ kind: "not-available" })
    expect(result.current.error).toEqual({ kind: "not-available" })
  })
})

describe("describeAdminError", () => {
  it("reads the message off whatever was thrown", () => {
    expect(describeAdminError(new CollabError(409, "conflict"))).toBe("conflict")
    expect(describeAdminError(new Error("plain"))).toBe("plain")
    expect(describeAdminError("string")).toBe("string")
  })
})

describe("membershipFailureMessage", () => {
  /** A 401 and a 403 have their own remedies. Everything else quotes the server. */
  it("maps every failure to a translation key under workspace.members", () => {
    expect(membershipFailureMessage({ kind: "not-available" })).toEqual({
      key: "errors.notAvailable",
    })
    expect(membershipFailureMessage({ kind: "no-workspace" })).toEqual({
      key: "errors.noWorkspace",
    })
    expect(membershipFailureMessage({ kind: "refused", status: 401, message: "x" })).toEqual({
      key: "errors.notSignedIn",
    })
    expect(membershipFailureMessage({ kind: "refused", status: 403, message: "x" })).toEqual({
      key: "errors.forbidden",
    })
    expect(membershipFailureMessage({ kind: "refused", status: 409, message: "busy" })).toEqual({
      key: "errors.server",
      values: { message: "busy" },
    })
    expect(membershipFailureMessage({ kind: "failed", message: "boom" })).toEqual({
      key: "errors.server",
      values: { message: "boom" },
    })
  })

  it("classifies whatever was thrown", () => {
    expect(toMembershipAdminFailure(new CollabError(403, "no"))).toEqual({
      kind: "refused",
      status: 403,
      message: "no",
    })
    expect(toMembershipAdminFailure(new MembershipAdminError({ kind: "no-workspace" }))).toEqual({
      kind: "no-workspace",
    })
    expect(toMembershipAdminFailure(new TypeError("network"))).toEqual({
      kind: "failed",
      message: "network",
    })
  })
})
