import {
  OrgSwitchUnavailableError,
  currentOrgIdOf,
  loadOrgSwitchSnapshot,
  switchOrganization,
  type OrgSwitchDeps,
} from "./org-switch"

import type { CollabAccountMembership } from "@/lib/collab/client"
import type { CloudSessionState } from "@/lib/identity/cloud-session"
import type { DeploymentDiscovery } from "@/lib/identity/deployment-discovery"

const session = { accessToken: "token-1", issuer: "https://id.example" }

const active = {
  status: "active",
  session,
  identity: { userId: "usr_ada", orgId: "org_a", orgRole: "admin" },
} as unknown as CloudSessionState

const ready = {
  status: "ready",
  collaborationServiceUrl: "https://collab.example",
} as unknown as DeploymentDiscovery

const beta: CollabAccountMembership = {
  orgId: "org_b",
  orgName: "Beta",
  logtoOrganizationId: "logto_b",
  userId: "usr_ada_b",
  orgRole: "member",
  workspaceCount: 2,
}

function deps(overrides: Partial<OrgSwitchDeps> = {}): OrgSwitchDeps {
  return {
    readState: async () => active,
    discover: async () => ready,
    listMemberships: async () => ({ memberships: [beta] }),
    adopt: jest.fn(async () => ({}) as never),
    notifyScopeChanged: jest.fn(),
    ...overrides,
  }
}

describe("loadOrgSwitchSnapshot", () => {
  it("lists memberships with the session's token for an active, ready profile", async () => {
    const listMemberships = jest.fn(async () => ({ memberships: [beta] }))
    const snapshot = await loadOrgSwitchSnapshot("acct_1", deps({ listMemberships }))
    expect(listMemberships).toHaveBeenCalledWith("https://collab.example", "token-1")
    expect(snapshot.memberships).toEqual([beta])
    expect(snapshot.membershipsError).toBeNull()
    expect(currentOrgIdOf(snapshot)).toBe("org_a")
  })

  it("lists nothing when signed out or when the deployment has no collaboration service", async () => {
    const listMemberships = jest.fn()
    const signedOut = await loadOrgSwitchSnapshot(
      "acct_1",
      deps({
        readState: async () => ({ status: "signed-out" }) as CloudSessionState,
        listMemberships,
      })
    )
    expect(signedOut.memberships).toBeNull()
    expect(currentOrgIdOf(signedOut)).toBeUndefined()

    const noService = await loadOrgSwitchSnapshot(
      "acct_1",
      deps({
        discover: async () => ({ status: "ready" }) as unknown as DeploymentDiscovery,
        listMemberships,
      })
    )
    expect(noService.memberships).toBeNull()
    expect(listMemberships).not.toHaveBeenCalled()
  })

  it("keeps the identity and reports the error when the listing fails", async () => {
    const snapshot = await loadOrgSwitchSnapshot(
      "acct_1",
      deps({
        listMemberships: async () => {
          throw new Error("unreachable")
        },
      })
    )
    expect(snapshot.state.status).toBe("active")
    expect(snapshot.memberships).toBeNull()
    expect(snapshot.membershipsError).toBe("unreachable")
  })
})

describe("switchOrganization", () => {
  it("adopts the target org and then tells open views to re-resolve", async () => {
    const order: string[] = []
    const d = deps({
      adopt: jest.fn(async () => {
        order.push("adopt")
        return {} as never
      }),
      notifyScopeChanged: jest.fn(() => order.push("notify")),
    })
    const snapshot = await loadOrgSwitchSnapshot("acct_1", d)
    await switchOrganization(snapshot, beta, "acct_1", d)

    expect(d.adopt).toHaveBeenCalledWith(
      ready,
      session,
      { orgId: "org_b", logtoOrganizationId: "logto_b", userId: "usr_ada_b" },
      { localAccountId: "acct_1" }
    )
    expect(order).toEqual(["adopt", "notify"])
  })

  it("does not announce a scope change when adoption fails", async () => {
    const d = deps({
      adopt: jest.fn(async () => {
        throw new Error("reauth-required")
      }),
    })
    const snapshot = await loadOrgSwitchSnapshot("acct_1", d)
    await expect(switchOrganization(snapshot, beta, "acct_1", d)).rejects.toThrow("reauth-required")
    expect(d.notifyScopeChanged).not.toHaveBeenCalled()
  })

  it("refuses to pretend a switch happened on a profile that cannot switch", async () => {
    const d = deps({ readState: async () => ({ status: "signed-out" }) as CloudSessionState })
    const snapshot = await loadOrgSwitchSnapshot("acct_1", d)
    await expect(switchOrganization(snapshot, beta, "acct_1", d)).rejects.toBeInstanceOf(
      OrgSwitchUnavailableError
    )
    expect(d.adopt).not.toHaveBeenCalled()
  })
})
