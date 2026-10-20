/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace}.${key}${values ? `:${Object.values(values).join(",")}` : ""}`,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

import { SidebarOrgSection } from "./sidebar-org-section"

import type { CollabAccountMembership } from "@/lib/collab/client"
import type { CloudSessionState } from "@/lib/identity/cloud-session"
import type { DeploymentDiscovery } from "@/lib/identity/deployment-discovery"
import type { OrgSwitchDeps } from "@/lib/identity/org-switch"

const alpha: CollabAccountMembership = {
  orgId: "org_a",
  orgName: "Alpha",
  logtoOrganizationId: "logto_a",
  userId: "usr_ada",
  orgRole: "admin",
  workspaceCount: 1,
}
const beta: CollabAccountMembership = {
  orgId: "org_b",
  orgName: "Beta",
  logtoOrganizationId: "logto_b",
  userId: "usr_ada_b",
  orgRole: "member",
  workspaceCount: 2,
}

function stateIn(orgId: string | undefined): CloudSessionState {
  return {
    status: "active",
    session: { accessToken: "token" },
    identity: { userId: "usr_ada", orgId, orgRole: "admin" },
  } as unknown as CloudSessionState
}

function deps(overrides: Partial<OrgSwitchDeps> = {}): OrgSwitchDeps {
  return {
    readState: async () => stateIn("org_a"),
    discover: async () =>
      ({ status: "ready", collaborationServiceUrl: "https://c" }) as unknown as DeploymentDiscovery,
    listMemberships: async () => ({ memberships: [alpha, beta] }),
    adopt: jest.fn(async () => ({}) as never),
    notifyScopeChanged: jest.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("SidebarOrgSection", () => {
  it("loads nothing and renders nothing while the menu is closed", () => {
    const readState = jest.fn(async () => stateIn("org_a"))
    render(<SidebarOrgSection accountId="acct_1" open={false} deps={deps({ readState })} />)
    expect(screen.queryByTestId("sidebar-org-section")).toBeNull()
    expect(readState).not.toHaveBeenCalled()
  })

  it("names the current org with the role held there, and offers the others", async () => {
    render(<SidebarOrgSection accountId="acct_1" open deps={deps()} />)
    const current = await screen.findByTestId("sidebar-org-current")
    expect(current).toHaveTextContent("Alpha")
    expect(current).toHaveTextContent("account.identity.roleName.admin")
    expect(screen.getByTestId("sidebar-org-switch-org_b")).toHaveTextContent(
      "desktop.sidebarUser.org.switchTo:Beta"
    )
    expect(screen.queryByTestId("sidebar-org-switch-org_a")).toBeNull()
  })

  it("switches through the shared path, closes the menu and announces the new org", async () => {
    const onSwitched = jest.fn()
    const d = deps()
    render(<SidebarOrgSection accountId="acct_1" open onSwitched={onSwitched} deps={d} />)
    fireEvent.click(await screen.findByTestId("sidebar-org-switch-org_b"))

    await waitFor(() => expect(onSwitched).toHaveBeenCalled())
    expect(d.adopt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { orgId: "org_b", logtoOrganizationId: "logto_b", userId: "usr_ada_b" },
      { localAccountId: "acct_1" }
    )
    expect(d.notifyScopeChanged).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith("desktop.sidebarUser.org.switched:Beta")
  })

  it("reports a failed switch without closing the menu", async () => {
    const onSwitched = jest.fn()
    const d = deps({
      adopt: jest.fn(async () => {
        throw new Error("reauth-required")
      }),
    })
    render(<SidebarOrgSection accountId="acct_1" open onSwitched={onSwitched} deps={d} />)
    fireEvent.click(await screen.findByTestId("sidebar-org-switch-org_b"))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("desktop.sidebarUser.org.switchFailed", {
        description: "reauth-required",
      })
    )
    expect(onSwitched).not.toHaveBeenCalled()
  })

  it("keeps the current org visible and says so when the listing fails", async () => {
    render(
      <SidebarOrgSection
        accountId="acct_1"
        open
        deps={deps({
          listMemberships: async () => {
            throw new Error("offline")
          },
        })}
      />
    )
    expect(await screen.findByTestId("sidebar-org-current")).toHaveTextContent("org_a")
    expect(screen.getByRole("alert")).toHaveTextContent("desktop.sidebarUser.org.listFailed")
  })

  it("renders nothing for a profile with no org at all", async () => {
    const readState = jest.fn(async () => stateIn(undefined))
    render(
      <SidebarOrgSection
        accountId="acct_1"
        open
        deps={deps({ readState, listMemberships: async () => ({ memberships: [] }) })}
      />
    )
    await waitFor(() => expect(readState).toHaveBeenCalled())
    expect(screen.queryByTestId("sidebar-org-section")).toBeNull()
  })
})
