/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key
    t.has = () => true
    return t
  },
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() } }))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))

import { toast } from "sonner"
import { openUrl } from "@/lib/native/opener"
import { CLOUD_OFFLINE_KEY_PREFIX } from "@/components/account/cloud-sign-in-gate"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import type { ReadyDeployment } from "@/lib/identity/deployment-discovery"

import { AccountIdentityTab, type AccountIdentityTabDeps } from "./account-identity-tab"

const account = { id: "acct_a", displayName: "Ada" } as LocalAccountRecord
const deployment: ReadyDeployment = {
  status: "ready",
  baseUrl: "https://host",
  config: { deploymentMode: "multi-tenant", hostId: "h" } as ReadyDeployment["config"],
  social: [],
  collaborationServiceUrl: "https://collab",
  registrationPolicy: null,
}
const session = {
  issuer: "i",
  clientId: "c",
  resource: "r",
  accessToken: "at",
  scopes: [],
  expiresAt: 5,
}

function deps(overrides: Partial<AccountIdentityTabDeps> = {}): AccountIdentityTabDeps {
  return {
    readState: jest.fn(async () => ({
      status: "active" as const,
      session,
      identity: {
        userId: "usr_1",
        logtoSubject: "s",
        displayName: "Ada",
        orgId: "org_a",
        orgRole: "owner" as const,
      },
    })),
    discover: jest.fn(async () => deployment),
    listMemberships: jest.fn(async () => ({
      memberships: [
        {
          orgId: "org_a",
          orgName: "Acme",
          userId: "usr_1",
          logtoOrganizationId: "la",
          workspaceCount: 1,
        },
        {
          orgId: "org_b",
          orgName: "Beta",
          userId: "usr_9",
          logtoOrganizationId: "lb",
          workspaceCount: 0,
        },
      ],
    })),
    adopt: jest.fn(async () => ({}) as never),
    signOut: jest.fn(async () => ({ endSessionUrl: "https://logto/end", tokensLive: true })),
    reload: jest.fn(),
    ...overrides,
  }
}

describe("AccountIdentityTab", () => {
  it("shows the person, the current organization by name, and the others with a switch", async () => {
    const d = deps()
    render(<AccountIdentityTab account={account} deps={d} />)
    expect(await screen.findByTestId("account-identity-person")).toHaveTextContent("Ada")
    await waitFor(() =>
      expect(screen.getByTestId("account-identity-org")).toHaveTextContent("Acme")
    )
    expect(screen.getByTestId("account-identity-membership-org_a")).toHaveTextContent("current")
    fireEvent.click(screen.getByTestId("account-identity-switch-org_b"))
    await waitFor(() =>
      expect(d.adopt).toHaveBeenCalledWith(
        deployment,
        session,
        { orgId: "org_b", logtoOrganizationId: "lb", userId: "usr_9" },
        { localAccountId: "acct_a" }
      )
    )
    expect(toast.success).toHaveBeenCalledWith("switched(Beta)")
    expect(d.listMemberships).toHaveBeenCalledWith("https://collab", "at")
  })

  it("signs out, warns when the issuer kept the tokens, and ends the issuer session", async () => {
    const d = deps()
    render(<AccountIdentityTab account={account} deps={d} />)
    fireEvent.click(await screen.findByTestId("account-identity-sign-out"))
    await waitFor(() => expect(d.signOut).toHaveBeenCalledWith("acct_a"))
    expect(toast.warning).toHaveBeenCalledWith("revocationFailed")
    expect(openUrl).toHaveBeenCalledWith("https://logto/end")
  })

  it("offers sign-in when signed out on a deployment, forgetting the tab's offline choice", async () => {
    sessionStorage.setItem(`${CLOUD_OFFLINE_KEY_PREFIX}.acct_a`, "1")
    const d = deps({ readState: jest.fn(async () => ({ status: "signed-out" as const })) })
    render(<AccountIdentityTab account={account} deps={d} />)
    expect(await screen.findByTestId("account-identity-signed-out")).toHaveTextContent("signedOut")
    fireEvent.click(screen.getByTestId("account-identity-sign-in"))
    expect(d.reload).toHaveBeenCalled()
    expect(sessionStorage.getItem(`${CLOUD_OFFLINE_KEY_PREFIX}.acct_a`)).toBeNull()
  })

  it("says when there is no deployment to sign in to", async () => {
    const d = deps({
      readState: jest.fn(async () => ({ status: "signed-out" as const })),
      discover: jest.fn(async () => ({ status: "none" as const, reason: "no-host" as const })),
    })
    render(<AccountIdentityTab account={account} deps={d} />)
    await screen.findByTestId("account-identity-signed-out")
    expect(screen.queryByTestId("account-identity-sign-in")).not.toBeInTheDocument()
    expect(screen.getByText("noDeployment")).toBeInTheDocument()
  })

  it("keeps the identity when the membership read fails", async () => {
    const d = deps({
      listMemberships: jest.fn(async () => {
        throw new Error("collab down")
      }),
    })
    render(<AccountIdentityTab account={account} deps={d} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("membershipsFailed(collab down)")
    expect(screen.getByTestId("account-identity-person")).toHaveTextContent("Ada")
  })
})
