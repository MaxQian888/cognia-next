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
jest.mock("@/lib/logto/capacitor-drivers", () => ({
  ...jest.requireActual("@/lib/logto/capacitor-drivers"),
  createLogtoCapacitorDrivers: () => ({ flavour: "capacitor" }),
}))

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
import { publishLogtoDeepLinkCallback } from "@/lib/logto/deep-link-callback"
import { forgetDeploymentSource, saveDeploymentSource } from "@/lib/identity/deployment-source"
import {
  CLOUD_OFFLINE_KEY_PREFIX,
  CloudSignInGate,
  forgetOfflineChoice,
  hasChosenOffline,
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
  webOrigin: null,
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
  it("does not interrupt local development with deployment login", () => {
    const environment = jest.replaceProperty(process, "env", {
      ...process.env,
      NODE_ENV: "development",
      NEXT_PUBLIC_ACCOUNT_GATE: "0",
    })
    try {
      const d = deps({ profile: "desktop" })
      renderGate(d)
      expect(screen.getByTestId("app")).toBeInTheDocument()
      expect(d.discover).not.toHaveBeenCalled()
    } finally {
      environment.restore()
    }
  })

  it("allows development to explicitly exercise deployment login", async () => {
    const environment = jest.replaceProperty(process, "env", {
      ...process.env,
      NODE_ENV: "development",
      NEXT_PUBLIC_ACCOUNT_GATE: "1",
    })
    try {
      renderGate(deps())
      expect(await screen.findByTestId("cloud-sign-in-social-github")).toBeInTheDocument()
      expect(screen.queryByTestId("app")).not.toBeInTheDocument()
    } finally {
      environment.restore()
    }
  })

  it.each(["/lark/workbench", "/lark/workbench/", "/lark/workbench.html"])(
    "lets the Feishu entry choose personal or team authentication at %s",
    (pathname) => {
      window.history.replaceState(null, "", `${pathname}#lark_session=token`)
      const d = deps({ pathname })
      renderGate(d)
      expect(screen.getByTestId("app")).toBeInTheDocument()
      expect(d.discover).not.toHaveBeenCalled()
      expect(window.location.hash).toBe("#lark_session=token")
      window.history.replaceState(null, "", "/")
    }
  )

  it("still requires cloud identity on the normal app and workbench-like paths", async () => {
    const { rerender } = renderGate(deps({ pathname: "/lark/workbench" }))
    rerender(
      <CloudSignInGate deps={deps({ pathname: "/lark/workbench-admin" })}>
        <div data-testid="protected" />
      </CloudSignInGate>
    )
    expect(await screen.findByTestId("cloud-sign-in-social-github")).toBeInTheDocument()
    expect(screen.queryByTestId("protected")).not.toBeInTheDocument()
  })

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
    const d = deps({
      settle: jest.fn(async () => ({ outcome: "choose" as const, identities: [], memberships })),
    })
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

  it("names the person who just signed in on the unaffiliated screen", async () => {
    const idToken = `h.${Buffer.from(JSON.stringify({ sub: "s", name: "Ada Lovelace" })).toString("base64url")}.s`
    const accessToken = `h.${Buffer.from(JSON.stringify({ sub: "s" })).toString("base64url")}.s`
    renderGate(
      deps({
        signIn: jest.fn(async () => ({ ...session, accessToken, idToken })),
        settle: jest.fn(async () => ({ outcome: "unaffiliated" as const, memberships: [] })),
      })
    )
    fireEvent.click(await screen.findByTestId("cloud-sign-in-social-github"))
    expect(await screen.findByTestId("cloud-sign-in-unaffiliated")).toBeInTheDocument()
    expect(screen.getByTestId("cloud-sign-in-person")).toHaveTextContent("Ada Lovelace")
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

  /** G1: the OS hands the deep link back and the wait resolves without a paste. */
  it("on the desktop, a delivered deep link completes the sign-in without pasting", async () => {
    const signIn = jest.fn(
      async (
        _deployment: unknown,
        _method: unknown,
        drivers: { waitForCode: (input: { state: string }) => Promise<unknown> }
      ) => {
        await drivers.waitForCode({ state: "st-1" })
        return session
      }
    )
    renderGate(deps({ profile: "desktop", signIn: signIn as never }))
    fireEvent.click(await screen.findByTestId("cloud-sign-in-social-github"))
    expect(await screen.findByTestId("cloud-sign-in-code")).toBeInTheDocument()
    publishLogtoDeepLinkCallback({
      kind: "logto_callback",
      code: "c-1",
      state: "st-1",
      error: null,
      raw: "cognia://logto/callback?code=c-1&state=st-1",
    })
    expect(await screen.findByTestId("app")).toBeInTheDocument()
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it("on the desktop, a deep link for another state is refused and the person can retry", async () => {
    const signIn = jest.fn(
      async (
        _deployment: unknown,
        _method: unknown,
        drivers: { waitForCode: (input: { state: string }) => Promise<unknown> }
      ) => {
        await drivers.waitForCode({ state: "st-1" })
        return session
      }
    )
    renderGate(deps({ profile: "desktop", signIn: signIn as never }))
    fireEvent.click(await screen.findByTestId("cloud-sign-in-social-github"))
    await screen.findByTestId("cloud-sign-in-code")
    publishLogtoDeepLinkCallback({
      kind: "logto_callback",
      code: "c-1",
      state: "someone-else",
      error: null,
      raw: "cognia://logto/callback?code=c-1&state=someone-else",
    })
    expect(await screen.findByTestId("cloud-sign-in-error")).toHaveTextContent("state mismatch")
    expect(screen.queryByTestId("app")).not.toBeInTheDocument()
  })

  /** G4: a WebView cannot pop a window, so Capacitor takes the native path. */
  it("on Capacitor, signs in through the in-app browser drivers and the native application", async () => {
    const signIn = jest.fn(async () => session)
    renderGate(
      deps({
        profile: "mobile-companion",
        isCapacitor: () => true,
        signIn: signIn as never,
      })
    )
    fireEvent.click(await screen.findByTestId("cloud-sign-in-social-github"))
    expect(await screen.findByTestId("app")).toBeInTheDocument()
    expect(signIn).toHaveBeenCalledWith(
      deployment,
      { kind: "social", directSignIn: "social:github" },
      { flavour: "capacitor" },
      { redirectUri: "cognia://logto/callback", clientKind: "native" },
      { localAccountId: "acct_a" }
    )
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

  /**
   * Settings can point a running app at a deployment. The gate must ask that
   * host, not stay passed on the answer it got from the old one.
   */
  it("decides again when the profile chooses a deployment after boot", async () => {
    localStorage.clear()
    let found: Awaited<ReturnType<NonNullable<CloudSignInGateDeps["discover"]>>> = {
      status: "none",
      reason: "single-user",
    }
    const discover = jest.fn(async () => found)
    renderGate(deps({ discover }))
    expect(await screen.findByTestId("app")).toBeInTheDocument()
    expect(discover).toHaveBeenCalledTimes(1)

    found = deployment
    saveDeploymentSource("acct_a", { baseUrl: "https://cloud.example" })
    expect(await screen.findByTestId("cloud-sign-in")).toBeInTheDocument()
    expect(discover).toHaveBeenCalledTimes(2)

    found = { status: "none", reason: "single-user" }
    forgetDeploymentSource("acct_a")
    expect(await screen.findByTestId("app")).toBeInTheDocument()
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it("on the desktop, points the host at the discovered deployment before asking", async () => {
    const configureHost = jest.fn(async () => null)
    renderGate(
      deps({
        profile: "desktop",
        configureHost,
        discover: jest.fn(async () => ({ ...deployment, fingerprint: "ab".repeat(32) })),
      })
    )
    expect(await screen.findByTestId("cloud-sign-in")).toBeInTheDocument()
    expect(configureHost).toHaveBeenCalledWith({
      gatewayUrl: "https://host.example",
      fingerprint: "ab".repeat(32),
      replace: true,
    })
  })

  it("does not touch a host on a browser or a phone", async () => {
    const configureHost = jest.fn(async () => null)
    renderGate(deps({ profile: "cloud-companion", configureHost }))
    expect(await screen.findByTestId("cloud-sign-in")).toBeInTheDocument()
    expect(configureHost).not.toHaveBeenCalled()
  })

  it("stays live under the E2E build only when the cloud-gate lane asks for it", async () => {
    const previous = {
      e2e: process.env.NEXT_PUBLIC_E2E,
      gate: process.env.NEXT_PUBLIC_E2E_CLOUD_GATE,
    }
    try {
      process.env.NEXT_PUBLIC_E2E = "1"
      delete process.env.NEXT_PUBLIC_E2E_CLOUD_GATE
      const discover = jest.fn(async () => deployment)
      const first = renderGate(deps({ discover }))
      expect(await screen.findByTestId("app")).toBeInTheDocument()
      expect(discover).not.toHaveBeenCalled()
      first.unmount()

      process.env.NEXT_PUBLIC_E2E_CLOUD_GATE = "1"
      renderGate(deps({ discover }))
      expect(await screen.findByTestId("cloud-sign-in")).toBeInTheDocument()
      expect(discover).toHaveBeenCalledTimes(1)
    } finally {
      if (previous.e2e === undefined) delete process.env.NEXT_PUBLIC_E2E
      else process.env.NEXT_PUBLIC_E2E = previous.e2e
      if (previous.gate === undefined) delete process.env.NEXT_PUBLIC_E2E_CLOUD_GATE
      else process.env.NEXT_PUBLIC_E2E_CLOUD_GATE = previous.gate
    }
  })

  it("forgets the tab's offline choice on request", () => {
    sessionStorage.setItem(`${CLOUD_OFFLINE_KEY_PREFIX}.acct_a`, "1")
    expect(hasChosenOffline("acct_a")).toBe(true)
    forgetOfflineChoice("acct_a")
    expect(hasChosenOffline("acct_a")).toBe(false)
  })
})
