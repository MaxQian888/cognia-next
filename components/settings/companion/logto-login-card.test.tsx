import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { LogtoLoginCard, extractCallback } from "./logto-login-card"
import { getActiveLogtoSession, signInToLogto, signOutFromLogto } from "@/lib/logto/app-session"
import { openUrl } from "@/lib/native/opener"

jest.mock("@/lib/logto/app-session", () => ({
  getActiveLogtoSession: jest.fn(),
  signInToLogto: jest.fn(),
  signOutFromLogto: jest.fn(),
}))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))

const getActive = getActiveLogtoSession as jest.Mock
const signIn = signInToLogto as jest.Mock
const signOut = signOutFromLogto as jest.Mock
const openUrlMock = openUrl as jest.Mock

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

  it("hints when not running in the desktop app", async () => {
    setTauri(false)
    render(<LogtoLoginCard />)
    expect(await screen.findByTestId("logto-desktop-only")).toBeInTheDocument()
  })
})
