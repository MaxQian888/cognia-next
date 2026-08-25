import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { LogtoLoginCard, extractCallback } from "./logto-login-card"
import { getActiveLogtoSession, signInToLogto, signOutFromLogto } from "@/lib/logto/app-session"
import {
  completeSignIn,
  completeSignOut,
  readSignedInPerson,
} from "@/lib/identity/complete-sign-in"
import { UserBindingError } from "@/lib/identity/user-binding"
import { openUrl } from "@/lib/native/opener"

jest.mock("@/lib/logto/app-session", () => ({
  getActiveLogtoSession: jest.fn(),
  signInToLogto: jest.fn(),
  signOutFromLogto: jest.fn(),
}))
// The identity flow owns Dexie and the Tauri bridge; this suite is about the
// card, so it stubs the flow rather than standing up a registry per test.
jest.mock("@/lib/identity/complete-sign-in", () => ({
  completeSignIn: jest.fn(),
  completeSignOut: jest.fn(),
  readSignedInPerson: jest.fn(),
}))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))

const getActive = getActiveLogtoSession as jest.Mock
const signIn = signInToLogto as jest.Mock
const signOut = signOutFromLogto as jest.Mock
const openUrlMock = openUrl as jest.Mock
const signInIdentity = completeSignIn as jest.Mock
const signOutIdentity = completeSignOut as jest.Mock
const readPerson = readSignedInPerson as jest.Mock

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
  getActive.mockReset().mockResolvedValue(null)
  signIn.mockReset()
  signOut.mockReset().mockResolvedValue(undefined)
  signInIdentity.mockReset().mockResolvedValue({ user: { id: "usr_ada" }, binding: {} })
  signOutIdentity.mockReset().mockResolvedValue(undefined)
  readPerson.mockReset().mockResolvedValue(null)
  openUrlMock.mockReset()
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
    getActive.mockResolvedValue(sess({ organizationId: "org_1" }))
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
    getActive.mockResolvedValue(sess())
    readPerson.mockResolvedValue({ userId: "usr_ada", displayName: "Ada" })

    render(<LogtoLoginCard />)

    expect(await screen.findByTestId("logto-person")).toHaveTextContent("Ada")
  })

  it("falls back to the user id when no display name was asserted", async () => {
    getActive.mockResolvedValue(sess())
    readPerson.mockResolvedValue({ userId: "usr_ada" })

    render(<LogtoLoginCard />)

    expect(await screen.findByTestId("logto-person")).toHaveTextContent("usr_ada")
  })

  it("says the profile is unlinked when a session exists but no person does", async () => {
    // Signing in to Logto and owning the profile are two facts; a session with
    // no binding is a real state and must not render as a blank cell.
    getActive.mockResolvedValue(sess())
    readPerson.mockResolvedValue(null)

    render(<LogtoLoginCard />)

    const cell = await screen.findByTestId("logto-person")
    expect(cell.textContent?.trim()).not.toBe("")
    expect(cell).not.toHaveTextContent("usr_")
  })

  it("clears the person when signing out, and drops the binding too", async () => {
    getActive.mockResolvedValue(sess())
    readPerson.mockResolvedValue({ userId: "usr_ada", displayName: "Ada" })

    render(<LogtoLoginCard />)
    await userEvent.click(await screen.findByTestId("logto-sign-out"))

    expect(signOutIdentity).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("logto-person")).not.toBeInTheDocument()
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
    signInIdentity.mockRejectedValue(
      new UserBindingError("already-bound-to-another-user", "taken", {
        localAccountId: "acct_alpha",
        userId: "usr_bob",
        displayName: "Bob",
        logtoSubject: "s",
        logtoIssuer: "i",
        boundAt: 1,
        updatedAt: 1,
      })
    )

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

    // The Logto session is real — `signInToLogto` persisted it — so the card
    // correctly shows the signed-in view. What failed is the profile binding,
    // and that has to be visible right there rather than on a form nobody sees.
    expect(await screen.findByTestId("logto-signed-in")).toBeInTheDocument()
    expect(await screen.findByTestId("logto-error")).toHaveTextContent("Bob")
    expect(await screen.findByTestId("logto-person")).toHaveTextContent(
      "Not linked to a Cognia account yet"
    )
    // And the way out is reachable: signing out clears both.
    expect(screen.getByTestId("logto-sign-out")).toBeInTheDocument()
    expect(signInIdentity).toHaveBeenCalledTimes(1)
  })
})
