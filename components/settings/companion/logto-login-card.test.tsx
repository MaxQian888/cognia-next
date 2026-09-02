import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { LogtoLoginCard, extractCallback } from "./logto-login-card"
import { signInToLogto, signOutFromLogto } from "@/lib/logto/app-session"
import { readCloudSessionState, type CloudSessionState } from "@/lib/identity/cloud-session"
import { completeSignIn, completeSignOut } from "@/lib/identity/complete-sign-in"
import { UserBindingError } from "@/lib/identity/user-binding"
import { openUrl } from "@/lib/native/opener"
import { toast } from "sonner"

jest.mock("@/lib/logto/app-session", () => ({
  signInToLogto: jest.fn(),
  signOutFromLogto: jest.fn(),
  signOutLeftTokensLive: jest.requireActual("@/lib/logto/app-session").signOutLeftTokensLive,
}))
// The identity flow owns Dexie and the Tauri bridge; this suite is about the
// card, so it stubs the flow rather than standing up a registry per test.
jest.mock("@/lib/identity/cloud-session", () => ({
  ...jest.requireActual("@/lib/identity/cloud-session"),
  readCloudSessionState: jest.fn(),
}))
jest.mock("@/lib/identity/complete-sign-in", () => ({
  completeSignIn: jest.fn(),
  completeSignOut: jest.fn(),
}))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))

const readState = readCloudSessionState as jest.Mock
const signIn = signInToLogto as jest.Mock
const signOut = signOutFromLogto as jest.Mock
const openUrlMock = openUrl as jest.Mock
const signInIdentity = completeSignIn as jest.Mock
const signOutIdentity = completeSignOut as jest.Mock
const toastWarning = toast.warning as jest.Mock

const SIGNED_OUT: CloudSessionState = { status: "signed-out" }

function active(
  sessionOver: Record<string, unknown> = {},
  identityOver: Record<string, unknown> = {}
): CloudSessionState {
  return {
    status: "active",
    session: sess(sessionOver) as never,
    identity: { userId: "usr_ada", logtoSubject: "s", ...identityOver } as never,
  }
}

function cleanSignOut() {
  return {
    hadSession: true,
    cleared: true as const,
    refreshTokenRevocation: { status: "revoked" as const },
    accessTokenRevocation: { status: "revoked" as const },
    endSessionUrl: null,
  }
}

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

function sess(over: Record<string, unknown> = {}) {
  return {
    issuer: "https://logto.test/oidc",
    clientId: "app_1",
    resource: "https://api.test",
    accessToken: "at",
    scopes: ["openid"],
    expiresAt: Date.now() + 3_600_000,
    ...over,
  }
}

beforeEach(() => {
  setTauri(true)
  readState.mockReset().mockResolvedValue(SIGNED_OUT)
  signIn.mockReset()
  signOut.mockReset().mockResolvedValue(cleanSignOut())
  signInIdentity.mockReset().mockResolvedValue({ user: { id: "usr_ada" }, binding: {} })
  signOutIdentity.mockReset().mockResolvedValue(undefined)
  openUrlMock.mockReset()
  toastWarning.mockReset()
})
afterEach(() => setTauri(false))

describe("extractCallback", () => {
  it("parses code + state from a callback URL", () => {
    expect(extractCallback("https://cb/x?code=abc&state=st")).toEqual({ code: "abc", state: "st" })
  })
  it("parses a URL with only a code", () => {
    expect(extractCallback("https://cb/x?code=abc")).toEqual({ code: "abc" })
  })
  it("accepts a bare code (trimmed)", () => {
    expect(extractCallback("  bare_code  ")).toEqual({ code: "bare_code" })
  })
  it("rejects empty, multi-word, and code-less URLs", () => {
    expect(extractCallback("")).toBeNull()
    expect(extractCallback("two words")).toBeNull()
    expect(extractCallback("https://cb/x?state=st")).toBeNull()
  })
})

describe("<LogtoLoginCard />", () => {
  it("shows the sign-in form when no session is stored", async () => {
    render(<LogtoLoginCard />)
    expect(await screen.findByTestId("logto-sign-in-form")).toBeInTheDocument()
  })

  it("shows the signed-in view and signs out", async () => {
    readState.mockResolvedValue(active({ organizationId: "org_1" }))
    const user = userEvent.setup()
    render(<LogtoLoginCard />)
    expect(await screen.findByTestId("logto-signed-in")).toBeInTheDocument()
    expect(screen.getByText("https://logto.test/oidc")).toBeInTheDocument()
    expect(screen.getByText("org_1")).toBeInTheDocument()

    await user.click(screen.getByTestId("logto-sign-out"))
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId("logto-sign-in-form")).toBeInTheDocument()
  })

  it("validates required fields before starting the flow", async () => {
    const user = userEvent.setup()
    render(<LogtoLoginCard />)
    await screen.findByTestId("logto-sign-in-form")
    await user.click(screen.getByTestId("logto-sign-in"))
    expect(screen.getByTestId("logto-error")).toBeInTheDocument()
    expect(signIn).not.toHaveBeenCalled()
  })

  it("runs the open-browser + paste-code flow and persists the session", async () => {
    // The mocked service drives the injected drivers exactly as the real
    // signInToLogto would: open the browser, await the pasted code, resolve.
    signIn.mockImplementation(
      async (
        _config: unknown,
        drivers: {
          openUrl: (u: string) => void
          waitForCode: (p: { redirectUri: string; state: string }) => Promise<unknown>
        }
      ) => {
        drivers.openUrl("https://authorize.example")
        await drivers.waitForCode({ redirectUri: "cb", state: "st-1" })
        readState.mockResolvedValue(active())
        return sess()
      }
    )
    const user = userEvent.setup()
    render(<LogtoLoginCard />)
    await screen.findByTestId("logto-sign-in-form")
    await user.type(screen.getByTestId("logto-issuer"), "https://logto.test/oidc")
    await user.type(screen.getByTestId("logto-client-id"), "app_1")
    await user.type(screen.getByTestId("logto-resource"), "https://api.test")
    await user.type(screen.getByTestId("logto-redirect"), "https://cb")
    await user.click(screen.getByTestId("logto-sign-in"))

    // Browser opened, now awaiting the pasted code.
    expect(openUrlMock).toHaveBeenCalledWith("https://authorize.example")
    const codeInput = await screen.findByTestId("logto-code-input")
    await user.type(codeInput, "the_code")
    await user.click(screen.getByTestId("logto-submit-code"))

    // Flow completes → signed-in view.
    expect(await screen.findByTestId("logto-signed-in")).toBeInTheDocument()
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it("says where the token is stored off the desktop, without gating sign-in", async () => {
    // This used to claim cloud sign-in was desktop-only. It never was: the
    // authorize step routes through the Capacitor in-app browser or
    // `window.open`, and the session falls back to an encrypted vault. Saying
    // "desktop only" hid a working feature and left a phone connecting to a
    // multi-user cloud deployment with no way to authenticate.
    setTauri(false)
    render(<LogtoLoginCard />)
    expect(await screen.findByTestId("logto-storage-note")).toBeInTheDocument()
    // The form is still there — the note is informational, not a gate. Awaited
    // separately because it only mounts once the session load settles.
    expect(await screen.findByTestId("logto-sign-in")).toBeEnabled()
  })
})

describe("the profile this session belongs to (ADR-0149)", () => {
  it("shows the signed-in person beside the session", async () => {
    readState.mockResolvedValue(active({}, { displayName: "Ada" }))

    render(<LogtoLoginCard />)

    expect(await screen.findByTestId("logto-person")).toHaveTextContent("Ada")
  })

  it("falls back to the user id when no display name was asserted", async () => {
    readState.mockResolvedValue(active())

    render(<LogtoLoginCard />)

    expect(await screen.findByTestId("logto-person")).toHaveTextContent("usr_ada")
  })

  it("a session with no binding is a sign-in-required state, not a blank cell", async () => {
    // Signing in to Logto and owning the profile are two facts. A token with
    // no binding is `binding-missing`: real, named, and never rendered as if
    // somebody were signed in.
    readState.mockResolvedValue({
      status: "reauth-required",
      reason: "binding-missing",
      sessionMetadata: {
        issuer: "https://logto.test/oidc",
        clientId: "c",
        resource: "r",
        scopes: [],
      },
    })

    render(<LogtoLoginCard />)

    expect(await screen.findByTestId("logto-state-reauth-required")).toBeInTheDocument()
    expect(screen.getByTestId("logto-state-reason")).toHaveTextContent(/not linked/i)
    expect(screen.queryByTestId("logto-signed-in")).not.toBeInTheDocument()
  })

  it("clears the person when signing out, and drops the binding too", async () => {
    readState.mockResolvedValue(active({}, { displayName: "Ada" }))

    render(<LogtoLoginCard />)
    await userEvent.click(await screen.findByTestId("logto-sign-out"))

    expect(signOutIdentity).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("logto-person")).not.toBeInTheDocument()
    expect(toastWarning).not.toHaveBeenCalled()
    // No end-session endpoint advertised: nothing to open.
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it("ends the issuer's own session in the browser when it advertises how", async () => {
    readState.mockResolvedValue(active())
    signOut.mockResolvedValue({
      ...cleanSignOut(),
      endSessionUrl: "https://logto.test/oidc/session/end?client_id=app_1",
    })

    render(<LogtoLoginCard />)
    await userEvent.click(await screen.findByTestId("logto-sign-out"))

    expect(openUrlMock).toHaveBeenCalledWith("https://logto.test/oidc/session/end?client_id=app_1")
  })

  it("warns when the issuer could not be told to revoke the token", async () => {
    readState.mockResolvedValue(active())
    signOut.mockResolvedValue({
      ...cleanSignOut(),
      refreshTokenRevocation: { status: "failed", reason: "ECONNREFUSED" },
    })

    render(<LogtoLoginCard />)
    await userEvent.click(await screen.findByTestId("logto-sign-out"))

    expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/could not be told/i))
    expect(await screen.findByTestId("logto-sign-in-form")).toBeInTheDocument()
  })

  it("names who holds the profile when the binding is refused, without hiding it", async () => {
    // Signing in to Logto succeeded; owning the profile did not. The user must
    // learn WHO holds it, because signing out here is the way forward.
    signIn.mockImplementation(
      async (
        _config: unknown,
        drivers: {
          openUrl: (u: string) => void
          waitForCode: (p: { redirectUri: string; state: string }) => Promise<unknown>
        }
      ) => {
        drivers.openUrl("https://authorize.example")
        await drivers.waitForCode({ redirectUri: "cb", state: "st-1" })
        return sess()
      }
    )
    // The session was persisted, the binding was refused: after the failed
    // sign-in the state re-reads as a token nobody local owns.
    signInIdentity.mockImplementation(async () => {
      readState.mockResolvedValue({
        status: "reauth-required",
        reason: "binding-missing",
        sessionMetadata: {
          issuer: "https://logto.test/oidc",
          clientId: "app_1",
          resource: "https://api.test",
          scopes: [],
        },
      })
      throw new UserBindingError("already-bound-to-another-user", "taken", {
        localAccountId: "acct_alpha",
        userId: "usr_bob",
        displayName: "Bob",
        logtoSubject: "s",
        logtoIssuer: "i",
        boundAt: 1,
        updatedAt: 1,
      })
    })

    const user = userEvent.setup()
    render(<LogtoLoginCard />)
    await screen.findByTestId("logto-sign-in-form")
    await user.type(screen.getByTestId("logto-issuer"), "https://logto.test/oidc")
    await user.type(screen.getByTestId("logto-client-id"), "app_1")
    await user.type(screen.getByTestId("logto-resource"), "https://api.test")
    await user.type(screen.getByTestId("logto-redirect"), "https://cb")
    await user.click(screen.getByTestId("logto-sign-in"))

    await user.type(await screen.findByTestId("logto-code-input"), "the_code")
    await user.click(screen.getByTestId("logto-submit-code"))

    // The Logto session is real (`signInToLogto` persisted it) but the profile
    // binding was refused, so the card shows the binding-missing state with
    // the refusal right there rather than on a form nobody sees.
    expect(await screen.findByTestId("logto-state-reauth-required")).toBeInTheDocument()
    expect(await screen.findByTestId("logto-error")).toHaveTextContent("Bob")
    // And the way out is reachable: signing out clears both.
    expect(screen.getByTestId("logto-sign-out")).toBeInTheDocument()
    expect(signInIdentity).toHaveBeenCalledTimes(1)
  })
})

describe("the states a login can be in (ADR-0149 lifecycle)", () => {
  const metadata = {
    issuer: "https://logto.test/oidc",
    clientId: "app_1",
    resource: "https://api.test",
    organizationId: "org_1",
    scopes: ["openid", "offline_access", "brain:rpc"],
  }

  it("an expired session asks for a new sign-in and pre-fills the form from what it knew", async () => {
    readState.mockResolvedValue({
      status: "reauth-required",
      reason: "expired",
      sessionMetadata: metadata,
    })
    const user = userEvent.setup()
    render(<LogtoLoginCard />)

    expect(await screen.findByTestId("logto-state-reauth-required")).toBeInTheDocument()
    expect(screen.getByTestId("logto-state-reason")).toHaveTextContent(/expired/i)
    expect(screen.getByText("org_1")).toBeInTheDocument()

    await user.click(screen.getByTestId("logto-sign-in-again"))
    expect(await screen.findByTestId("logto-sign-in-form")).toBeInTheDocument()
    expect(screen.getByTestId("logto-issuer")).toHaveValue("https://logto.test/oidc")
    expect(screen.getByTestId("logto-client-id")).toHaveValue("app_1")
    expect(screen.getByTestId("logto-resource")).toHaveValue("https://api.test")
    expect(screen.getByTestId("logto-org")).toHaveValue("org_1")
    expect(screen.getByTestId("logto-scope")).toHaveValue("brain:rpc")
  })

  it("a revoked session says so", async () => {
    readState.mockResolvedValue({
      status: "reauth-required",
      reason: "revoked",
      sessionMetadata: metadata,
    })
    render(<LogtoLoginCard />)
    expect(await screen.findByTestId("logto-state-reason")).toHaveTextContent(/revoked/i)
  })

  it("offline keeps the person signed in and offers a retry, not a sign-in", async () => {
    readState.mockResolvedValue({ status: "offline", sessionMetadata: metadata })
    const user = userEvent.setup()
    render(<LogtoLoginCard />)

    expect(await screen.findByTestId("logto-state-offline")).toBeInTheDocument()
    expect(screen.queryByTestId("logto-sign-in-again")).not.toBeInTheDocument()

    readState.mockResolvedValue(active())
    await user.click(screen.getByTestId("logto-retry"))
    expect(await screen.findByTestId("logto-signed-in")).toBeInTheDocument()
  })

  it("an issuer error names the reason", async () => {
    readState.mockResolvedValue({
      status: "error",
      reason: "invalid_client",
      sessionMetadata: metadata,
    })
    render(<LogtoLoginCard />)
    expect(await screen.findByTestId("logto-state-error")).toBeInTheDocument()
    expect(screen.getByTestId("logto-state-reason")).toHaveTextContent("invalid_client")
  })
})
