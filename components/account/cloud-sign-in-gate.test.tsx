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
jest.mock("next/navigation", () => ({ usePathname: () => "/" }))
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => "main",
  isSecondaryOverlayRole: () => false,
}))
jest.mock("@/lib/logto/web-popup", () => ({
  createLogtoWebPopupDrivers: () => ({ openUrl: jest.fn(), waitForCode: jest.fn() }),
}))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))

let mockStore = {
  loaded: true,
  locked: false,
  unlockedAccountId: "acct_a" as string | null,
  activeAccountId: "acct_a" as string | null,
}
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

import { CollabError } from "@/lib/collab/client"
import {
  CLOUD_OFFLINE_KEY_PREFIX,
  CloudSignInGate,
  type CloudSignInGateDeps,
} from "./cloud-sign-in-gate"
import type { ReadyDeployment } from "@/lib/identity/deployment-discovery"
import type { LogtoSession } from "@/lib/logto/client"

const deployment: ReadyDeployment = {
  status: "ready",
  baseUrl: "https://host.example",
  config: {
    deploymentMode: "multi-tenant",
    hostId: "h",
    oidc: { issuer: "https://logto.example/oidc", webClientId: "w", audience: "a", scopes: [] },
  } as unknown as ReadyDeployment["config"],
  social: [{ provider: "github", directSignIn: "social:github" }],
  collaborationServiceUrl: "https://collab.example",
  registrationPolicy: "bootstrap-then-invite",
}

const session: LogtoSession = {
  issuer: "https://logto.example/oidc",
  clientId: "w",
  resource: "a",
  accessToken: "at",
  refreshToken: "rt",
  scopes: [],
}

function deps(overrides: Partial<CloudSignInGateDeps> = {}): CloudSignInGateDeps {
  return {
    discover: jest.fn(async () => deployment),
    readState: jest.fn(async () => ({ status: "signed-out" as const })),
    signIn: jest.fn(async () => session),
    settle: jest.fn(async () => ({ outcome: "adopted" as const, adopted: {} as never })),
    adopt: jest.fn(async () => ({}) as never),
    claim: jest.fn(async () => ({}) as never),
    redeem: jest.fn(async () => ({}) as never),
    signOut: jest.fn(async () => undefined),
    profile: "cloud-companion",
    ...overrides,
  }
}

function renderGate(d: CloudSignInGateDeps) {
  return render(
    <CloudSignInGate deps={d}>
      <div data-testid="app" />
    </CloudSignInGate>
  )
}

beforeEach(() => {
  sessionStorage.clear()
  mockStore = {
    loaded: true,
    locked: false,
    unlockedAccountId: "acct_a",
    activeAccountId: "acct_a",
  }
})

describe("CloudSignInGate", () => {
  /** Most installs: nothing to sign in to, and the gate is invisible. */
  it("passes straight through when there is no multi-tenant deployment", async () => {
    renderGate(
      deps({
        discover: jest.fn(async () => ({
          status: "none" as const,
          reason: "single-user" as const,
        })),
      })
    )
    expect(await screen.findByTestId("app")).toBeInTheDocument()
  })

  it("passes while the profile is locked and on the ungated paths", () => {
    mockStore = { ...mockStore, locked: true }
    renderGate(deps())
    expect(screen.getByTestId("app")).toBeInTheDocument()
    mockStore = { ...mockStore, locked: false }
    render(
      <CloudSignInGate deps={deps({ pathname: "/logto/callback" })}>
        <div data-testid="callback" />
      </CloudSignInGate>
    )
    expect(screen.getByTestId("callback")).toBeInTheDocument()
  })

  it("passes an active session that already has an organization", async () => {
    renderGate(
      deps({
        readState: jest.fn(async () => ({
          status: "active" as const,
          session,
          identity: { userId: "usr_1", logtoSubject: "s", orgId: "org_1" },
        })),
      })
    )
    expect(await screen.findByTestId("app")).toBeInTheDocument()
  })

  it("shows the sign-in screen when signed out, and signs in with the chosen social method", async () => {
    const d = deps()
    renderGate(d)
    fireEvent.click(await screen.findByTestId("cloud-sign-in-social-github"))
    await waitFor(() => expect(d.signIn).toHaveBeenCalled())
    const [dep, method, , options, flowDeps] = (d.signIn as jest.Mock).mock.calls[0]!
    expect(dep).toBe(deployment)
    expect(method).toEqual({ kind: "social", directSignIn: "social:github" })
    expect(options).toEqual({
      redirectUri: `${window.location.origin}/logto/callback`,
      clientKind: "web",
    })
    expect(flowDeps).toEqual({ localAccountId: "acct_a" })
    // Settled as adopted: the app paints.
    expect(await screen.findByTestId("app")).toBeInTheDocument()
  })

  it("offers the organizations when there are several and adopts the chosen one", async () => {
    const memberships = [
      {
        orgId: "org_a",
        orgName: "A",
        userId: "usr_a",
        logtoOrganizationId: "la",
        workspaceCount: 1,
      },
      {
        orgId: "org_b",
        orgName: "B",
        userId: "usr_b",
        logtoOrganizationId: "lb",
        workspaceCount: 0,
      },
    ]
    const d = deps({ settle: jest.fn(async () => ({ outcome: "choose" as const, memberships })) })
    renderGate(d)
    fireEvent.click(await screen.findByTestId("cloud-sign-in-logto"))
    fireEvent.click(await screen.findByTestId("cloud-sign-in-choose-org_b"))
    await waitFor(() =>
      expect(d.adopt).toHaveBeenCalledWith(
        deployment,
        session,
        { orgId: "org_b", logtoOrganizationId: "lb", userId: "usr_b" },
        { localAccountId: "acct_a" }
      )
    )
    expect(await screen.findByTestId("app")).toBeInTheDocument()
  })

  it("asks for an invitation or the credential when the person is in no organization", async () => {
    const d = deps({ settle: jest.fn(async () => ({ outcome: "unaffiliated" as const })) })
    renderGate(d)
    fireEvent.click(await screen.findByTestId("cloud-sign-in-logto"))
    expect(await screen.findByTestId("cloud-sign-in-unaffiliated")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("cloud-sign-in-credential"), { target: { value: "cred" } })
    fireEvent.change(screen.getByTestId("cloud-sign-in-org-name"), { target: { value: "Acme" } })
    fireEvent.click(screen.getByTestId("cloud-sign-in-claim-submit"))
    await waitFor(() =>
      expect(d.claim).toHaveBeenCalledWith(
        deployment,
        session,
        { credential: "cred", orgName: "Acme" },
        { localAccountId: "acct_a" }
      )
    )
    expect(await screen.findByTestId("app")).toBeInTheDocument()
  })

  it("translates a refused invitation and stays on the screen", async () => {
    const d = deps({
      settle: jest.fn(async () => ({ outcome: "unaffiliated" as const })),
      redeem: jest.fn(async () => {
        throw new CollabError(404, "no such invitation")
      }),
    })
    renderGate(d)
    fireEvent.click(await screen.findByTestId("cloud-sign-in-logto"))
    await screen.findByTestId("cloud-sign-in-unaffiliated")
    fireEvent.change(screen.getByTestId("cloud-sign-in-token"), {
      target: { value: "Qm9uam91ciBsZSBtb25kZSwgamUgc3VpcyB1biB0b2tlbg" },
    })
    fireEvent.click(screen.getByTestId("cloud-sign-in-redeem-submit"))
    expect(await screen.findByTestId("cloud-sign-in-error")).toHaveTextContent("error.notInvited")
    expect(screen.queryByTestId("app")).not.toBeInTheDocument()
  })

  /** The local profile works without the cloud. The choice is kept for the tab. */
  it("lets the person continue offline and remembers it for the tab", async () => {
    renderGate(deps())
    fireEvent.click(await screen.findByTestId("cloud-sign-in-offline"))
    expect(await screen.findByTestId("app")).toBeInTheDocument()
    expect(sessionStorage.getItem(`${CLOUD_OFFLINE_KEY_PREFIX}.acct_a`)).toBe("1")
    renderGate(deps())
    expect(await screen.findByTestId("app")).toBeInTheDocument()
  })

  it("names the host it could not reach, and passes a kept session that is merely offline", async () => {
    renderGate(
      deps({
        discover: jest.fn(async () => ({
          status: "unavailable" as const,
          reason: "unreachable" as const,
          baseUrl: "https://h",
          message: "down",
        })),
      })
    )
    expect(await screen.findByTestId("cloud-sign-in-unavailable")).toBeInTheDocument()

    render(
      <CloudSignInGate
        deps={deps({
          readState: jest.fn(async () => ({
            status: "offline" as const,
            sessionMetadata: { issuer: "i", clientId: "c", resource: "r", scopes: [] },
          })),
        })}
      >
        <div data-testid="offline-app" />
      </CloudSignInGate>
    )
    expect(await screen.findByTestId("offline-app")).toBeInTheDocument()
  })

  it("says why a lapsed session must be renewed", async () => {
    renderGate(
      deps({
        readState: jest.fn(async () => ({
          status: "reauth-required" as const,
          reason: "expired" as const,
          sessionMetadata: null,
        })),
      })
    )
    expect(await screen.findByTestId("cloud-sign-in-reauth-expired")).toBeInTheDocument()
  })
})
