/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key
    t.has = () => true
    return t
  },
}))

import type { ReadyDeployment } from "@/lib/identity/deployment-discovery"

import { CloudSignInScreen, type CloudSignInScreenProps } from "./cloud-sign-in-screen"

const deployment: ReadyDeployment = {
  status: "ready",
  baseUrl: "https://host.example",
  config: {
    deploymentMode: "multi-tenant",
    hostId: "h",
    oidc: { issuer: "https://logto.example/oidc", webClientId: "w", audience: "a", scopes: [] },
  } as unknown as ReadyDeployment["config"],
  social: [
    { provider: "github", directSignIn: "social:github" },
    { provider: "acme-sso", directSignIn: "sso:acme" },
  ],
  collaborationServiceUrl: "https://collab.example",
  registrationPolicy: "bootstrap-then-invite",
}

function handlers(): Omit<CloudSignInScreenProps, "view" | "error" | "busy"> {
  return {
    onSocial: jest.fn(),
    onLogto: jest.fn(),
    onManual: jest.fn(),
    onSubmitCode: jest.fn(),
    onCancelCode: jest.fn(),
    onContinueOffline: jest.fn(),
    onChoose: jest.fn(),
    onRedeem: jest.fn(),
    onClaim: jest.fn(),
    onSignOut: jest.fn(),
  }
}

describe("CloudSignInScreen", () => {
  it("offers every social method by name, the plain Logto page, offline, and a manual form", () => {
    const h = handlers()
    render(
      <CloudSignInScreen
        view={{ kind: "sign-in", deployment, canContinueOffline: true }}
        error={null}
        busy={false}
        {...h}
      />
    )
    expect(screen.getByRole("heading")).toHaveTextContent("title(logto.example)")
    // A known provider gets its translated name, an unknown one its own.
    expect(screen.getByTestId("cloud-sign-in-social-github")).toHaveTextContent(
      "continueWith(provider.github)"
    )
    expect(screen.getByTestId("cloud-sign-in-social-acme-sso")).toHaveTextContent(
      "continueWith(acme-sso)"
    )
    fireEvent.click(screen.getByTestId("cloud-sign-in-social-github"))
    expect(h.onSocial).toHaveBeenCalledWith({ provider: "github", directSignIn: "social:github" })
    fireEvent.click(screen.getByTestId("cloud-sign-in-logto"))
    expect(h.onLogto).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("cloud-sign-in-offline"))
    expect(h.onContinueOffline).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("cloud-sign-in-advanced-toggle"))
    fireEvent.click(screen.getByTestId("cloud-sign-in-manual-submit"))
    expect(h.onManual).not.toHaveBeenCalled()
    for (const [key, value] of Object.entries({
      issuer: " https://x/oidc ",
      clientId: "c",
      resource: "r",
      redirectUri: "u",
    })) {
      fireEvent.input(screen.getByTestId(`cloud-sign-in-manual-${key}`), { target: { value } })
    }
    fireEvent.click(screen.getByTestId("cloud-sign-in-manual-submit"))
    expect(h.onManual).toHaveBeenCalledWith({
      issuer: "https://x/oidc",
      clientId: "c",
      resource: "r",
      redirectUri: "u",
    })
  })

  it("says why a lapsed session needs signing in again", () => {
    render(
      <CloudSignInScreen
        view={{ kind: "sign-in", deployment, reauth: "revoked", canContinueOffline: false }}
        error={null}
        busy={false}
        {...handlers()}
      />
    )
    expect(screen.getByTestId("cloud-sign-in-reauth-revoked")).toHaveTextContent("reauth.revoked")
    expect(screen.queryByTestId("cloud-sign-in-offline")).not.toBeInTheDocument()
  })

  it("takes the pasted callback and can cancel", () => {
    const h = handlers()
    render(<CloudSignInScreen view={{ kind: "awaiting-code" }} error={null} busy={false} {...h} />)
    expect(screen.getByTestId("cloud-sign-in-code-submit")).toBeDisabled()
    fireEvent.change(screen.getByTestId("cloud-sign-in-code-input"), {
      target: { value: "https://cb?code=abc&state=s" },
    })
    fireEvent.click(screen.getByTestId("cloud-sign-in-code-submit"))
    expect(h.onSubmitCode).toHaveBeenCalledWith("https://cb?code=abc&state=s")
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(h.onCancelCode).toHaveBeenCalled()
  })

  it("lists organizations with role and workspace count and reports the choice", () => {
    const h = handlers()
    const memberships = [
      {
        orgId: "org_a",
        orgName: "Acme",
        userId: "usr_1",
        orgRole: "owner" as const,
        workspaceCount: 3,
      },
      { orgId: "org_b", orgName: "Beta", userId: "usr_2", workspaceCount: 1 },
    ]
    render(
      <CloudSignInScreen
        view={{ kind: "choose", memberships }}
        error={null}
        busy={false}
        personName="Ada"
        {...h}
      />
    )
    expect(screen.getByTestId("cloud-sign-in-org-org_a")).toHaveTextContent("role.owner")
    expect(screen.getByTestId("cloud-sign-in-org-org_b")).toHaveTextContent("role.guest")
    expect(screen.getByTestId("cloud-sign-in-org-org_b")).toHaveTextContent("workspaces(1)")
    fireEvent.click(screen.getByTestId("cloud-sign-in-choose-org_b"))
    expect(h.onChoose).toHaveBeenCalledWith(memberships[1])
    expect(screen.getByTestId("cloud-sign-in-person")).toHaveTextContent("signedInAs(Ada)")
    fireEvent.click(screen.getByTestId("cloud-sign-in-sign-out"))
    expect(h.onSignOut).toHaveBeenCalled()
  })

  it("validates the invitation token and the claim before calling out", () => {
    const h = handlers()
    render(
      <CloudSignInScreen
        view={{ kind: "unaffiliated", deployment, allowClaim: true }}
        error={null}
        busy={false}
        {...h}
      />
    )
    fireEvent.change(screen.getByTestId("cloud-sign-in-token"), { target: { value: "nope" } })
    fireEvent.click(screen.getByTestId("cloud-sign-in-redeem-submit"))
    expect(h.onRedeem).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("invitation.invalid")
    const token = "Qm9uam91ciBsZSBtb25kZSwgamUgc3VpcyB1biB0b2tlbg"
    fireEvent.change(screen.getByTestId("cloud-sign-in-token"), { target: { value: ` ${token} ` } })
    fireEvent.click(screen.getByTestId("cloud-sign-in-redeem-submit"))
    expect(h.onRedeem).toHaveBeenCalledWith(token)

    fireEvent.click(screen.getByTestId("cloud-sign-in-claim-submit"))
    expect(h.onClaim).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId("cloud-sign-in-credential"), { target: { value: "cred" } })
    fireEvent.change(screen.getByTestId("cloud-sign-in-org-name"), { target: { value: " Acme " } })
    fireEvent.click(screen.getByTestId("cloud-sign-in-claim-submit"))
    expect(h.onClaim).toHaveBeenCalledWith({ credential: "cred", orgName: "Acme" })
  })

  it("hides the claim when the deployment does not allow it, and shows errors", () => {
    render(
      <CloudSignInScreen
        view={{ kind: "unaffiliated", deployment, allowClaim: false }}
        error="boom"
        busy={false}
        {...handlers()}
      />
    )
    expect(screen.queryByTestId("cloud-sign-in-claim")).not.toBeInTheDocument()
    expect(screen.getByTestId("cloud-sign-in-error")).toHaveTextContent("boom")
  })

  it("names the host it could not reach and lets the person carry on offline", () => {
    const h = handlers()
    render(
      <CloudSignInScreen
        view={{
          kind: "unavailable",
          baseUrl: "https://h",
          message: "down",
          canContinueOffline: true,
        }}
        error={null}
        busy={false}
        {...h}
      />
    )
    expect(screen.getByTestId("cloud-sign-in-unavailable")).toHaveTextContent(
      "unavailable.body(https://h,down)"
    )
    fireEvent.click(screen.getByTestId("cloud-sign-in-offline"))
    expect(h.onContinueOffline).toHaveBeenCalled()
  })
})
