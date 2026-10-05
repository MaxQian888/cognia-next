/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key
    t.has = () => true
    return t
  },
  // The lock-screen backdrop formats its clock and date through next-intl.
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() } }))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))

import { toast } from "sonner"
import { openUrl } from "@/lib/native/opener"
import { CLOUD_OFFLINE_KEY_PREFIX } from "@/components/account/cloud-sign-in-gate"

jest.mock("@/components/settings/companion/cloud-deployment-card", () => ({
  CloudDeploymentCard: (props: { frame?: string; deps?: { localAccountId?: string } }) => (
    <div
      data-testid="stub-deployment-card"
      data-frame={props.frame}
      data-account={props.deps?.localAccountId}
    />
  ),
}))
let mockServed = "acct_a"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (
    selector: (state: { unlockedAccountId: string | null; activeAccountId: string }) => unknown
  ) => selector({ unlockedAccountId: mockServed, activeAccountId: mockServed }),
}))
jest.mock("@/components/account/sync/account-sync-section", () => ({
  AccountSyncSection: (props: { account: string }) => (
    <div data-testid="stub-account-sync" data-account={props.account} />
  ),
}))
jest.mock("@/components/account/manage/official-account-deletion", () => ({
  OfficialAccountDeletion: (props: { session: { accessToken: string } }) => (
    <div data-testid="stub-official-deletion" data-token={props.session.accessToken} />
  ),
}))
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { officialDeployment } from "@/lib/identity/official-deployment"
import { IDENTITIES_CLAIM } from "@/lib/identity/issuer-identities"
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
  webOrigin: null,
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
    // The way out is to name a deployment, right here, for this profile.
    const card = screen.getByTestId("stub-deployment-card")
    expect(card).toHaveAttribute("data-frame", "plain")
    expect(card).toHaveAttribute("data-account", "acct_a")
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

  describe("with the official account", () => {
    const official = officialDeployment({})!
    const discoverOfficial = jest.fn(async () => ({
      status: "official" as const,
      deployment: official,
      reason: "single-user" as const,
    }))
    const idToken = `h.${Buffer.from(
      JSON.stringify({
        [IDENTITIES_CLAIM]: [
          { provider: "lark", tenant: "t1", subject: "on_1" },
          { provider: "github", subject: "42" },
        ],
      })
    ).toString("base64url")}.s`
    const activeOfficial = jest.fn(async () => ({
      status: "active" as const,
      session: { ...session, idToken, issuer: official.issuer },
      identity: { userId: "usr_1", logtoSubject: "usr_1", displayName: "Ada" },
    }))

    it("shows the person and their linked sign-ins, no organizations, and the deletion", async () => {
      const d = deps({ discover: discoverOfficial, readState: activeOfficial })
      render(<AccountIdentityTab account={account} deps={d} />)
      expect(await screen.findByTestId("account-identity-person")).toHaveTextContent("Ada")
      expect(screen.getByText("officialTitle")).toBeInTheDocument()
      expect(screen.getByTestId("account-identity-linked")).toHaveTextContent("feishu, github")
      expect(screen.queryByTestId("account-identity-org")).not.toBeInTheDocument()
      expect(screen.queryByText("memberships")).not.toBeInTheDocument()
      expect(d.listMemberships).not.toHaveBeenCalled()
      expect(screen.getByTestId("stub-official-deletion")).toHaveAttribute("data-token", "at")
      // Account sync's section (null itself when the build lacks the feature).
      expect(screen.getByTestId("stub-account-sync")).toHaveAttribute("data-account", "Ada")
      // A self-hosted gateway can still replace the official account.
      expect(screen.getByText("selfHosted")).toBeInTheDocument()
      expect(screen.getByTestId("stub-deployment-card")).toBeInTheDocument()
    })

    it("asks the gate for its screen instead of reloading", async () => {
      const requestSignIn = jest.fn()
      const d = deps({
        discover: discoverOfficial,
        readState: jest.fn(async () => ({ status: "signed-out" as const })),
        requestSignIn,
      })
      render(<AccountIdentityTab account={account} deps={d} />)
      fireEvent.click(await screen.findByTestId("account-identity-sign-in"))
      expect(requestSignIn).toHaveBeenCalledWith("acct_a")
      expect(d.reload).not.toHaveBeenCalled()
      expect(screen.queryByTestId("stub-official-deletion")).not.toBeInTheDocument()
    })

    it("does not treat a session from another issuer as the official account", async () => {
      const d = deps({
        discover: discoverOfficial,
        readState: jest.fn(async () => ({
          status: "active" as const,
          // A self-hosted login left behind after its deployment was forgotten.
          session: { ...session, issuer: "https://logto.example/oidc", idToken },
          identity: { userId: "usr_1", logtoSubject: "s", displayName: "Ada" },
        })),
      })
      render(<AccountIdentityTab account={account} deps={d} />)
      expect(await screen.findByTestId("account-identity-person")).toHaveTextContent("Ada")
      expect(screen.queryByTestId("account-identity-linked")).not.toBeInTheDocument()
      expect(screen.queryByTestId("stub-official-deletion")).not.toBeInTheDocument()
      expect(screen.queryByTestId("stub-account-sync")).not.toBeInTheDocument()
      expect(screen.getByTestId("account-identity-sign-out")).toBeInTheDocument()
    })

    it("only lets the profile the gate serves ask for the official screen", async () => {
      mockServed = "acct_other"
      try {
        const requestSignIn = jest.fn()
        render(
          <AccountIdentityTab
            account={account}
            deps={deps({
              discover: discoverOfficial,
              readState: jest.fn(async () => ({ status: "signed-out" as const })),
              requestSignIn,
            })}
          />
        )
        const button = await screen.findByTestId("account-identity-sign-in")
        expect(button).toBeDisabled()
        expect(button).toHaveAttribute("title", "signInOtherProfile")
      } finally {
        mockServed = "acct_a"
      }
    })

    it("says so when the issuer reported no linked sign-ins", async () => {
      const d = deps({
        discover: discoverOfficial,
        readState: jest.fn(async () => ({
          status: "active" as const,
          session: { ...session, issuer: official.issuer },
          identity: { userId: "usr_1", logtoSubject: "usr_1" },
        })),
      })
      render(<AccountIdentityTab account={account} deps={d} />)
      expect(await screen.findByTestId("account-identity-linked")).toHaveTextContent("linkedNone")
    })
  })
})
