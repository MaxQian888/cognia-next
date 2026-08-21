/**
 * @jest-environment jsdom
 *
 * Task 42 — ConnectorDeepLinkRouter.
 *
 * Covers:
 *  - Web mode: onDeepLink not called.
 *  - Tauri mode, unknown path: handler not invoked.
 *  - Tauri mode, state mismatch: localized `connectors.oauth.stateMismatch`.
 *  - Tauri mode, unknown adapterType: localized `connectors.oauth.unknownPlatform`.
 *  - Tauri mode, registered handler: handler invoked, toast.success.
 *  - Tauri mode, handler throws: toast.error with error message.
 */

import { render, waitFor } from "@testing-library/react"
import { ConnectorDeepLinkRouter } from "./connector-deep-link-router"
import { isTauri } from "@/lib/tauri"
import { oauthRegistry } from "@/lib/connectors/oauth-registry"
import enMessages from "@/i18n/messages/en.json"

/**
 * Every toast here is localized (`connectors.oauth.*`). Asserting against the
 * bundle rather than a copy keeps the test honest if the wording is edited,
 * while still failing if a raw English literal creeps back into the router.
 */
const OAUTH_MESSAGES = enMessages.connectors.oauth

// ── Mock isTauri ─────────────────────────────────────────────────────────────
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

// ── Mock deep-link ────────────────────────────────────────────────────────────
let capturedDeepLinkHandler: ((urls: string[]) => void) | null = null
const mockOnDeepLink = jest.fn().mockImplementation(async (handler: (urls: string[]) => void) => {
  capturedDeepLinkHandler = handler
  return jest.fn() // unsubscribe fn
})
const mockLaunchDeepLink = jest.fn(async (): Promise<string[] | null> => null)
jest.mock("@/lib/tauri/deep-link", () => ({
  onDeepLink: (...args: unknown[]) => mockOnDeepLink(...args),
  getLaunchDeepLink: () => mockLaunchDeepLink(),
}))

// ── Mock Capacitor deeplink + browser (mobile branch) ────────────────────────
let capturedCapHandler: ((route: { raw: string }) => void) | null = null
const mockCapSubscribe = jest.fn(async (handler: (route: { raw: string }) => void) => {
  capturedCapHandler = handler
  return jest.fn()
})
const mockCapLaunchRoute = jest.fn(async (): Promise<{ raw: string } | null> => null)
jest.mock("@/lib/capacitor/deeplink", () => ({
  subscribe: (handler: (route: { raw: string }) => void) => mockCapSubscribe(handler),
  getLaunchRoute: () => mockCapLaunchRoute(),
}))
const mockCapBrowserClose = jest.fn(async () => ({ kind: "ok" }))
jest.mock("@/lib/capacitor/browser", () => ({
  close: () => mockCapBrowserClose(),
}))

function setCapacitor(on: boolean) {
  const w = window as unknown as Record<string, unknown>
  if (on) w.Capacitor = { isNativePlatform: () => true }
  else delete w.Capacitor
}

// ── Mock toast ────────────────────────────────────────────────────────────────
const mockToastError = jest.fn()
const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}))

// ── sessionStorage helpers ───────────────────────────────────────────────────
function setOAuthState(state: string) {
  sessionStorage.setItem("connector-oauth-state", state)
}

function clearOAuthState() {
  sessionStorage.removeItem("connector-oauth-state")
  localStorage.removeItem("connector-oauth-state")
}

beforeEach(() => {
  jest.clearAllMocks()
  capturedDeepLinkHandler = null
  capturedCapHandler = null
  mockCapLaunchRoute.mockResolvedValue(null)
  mockLaunchDeepLink.mockResolvedValue(null)
  setCapacitor(false)
  oauthRegistry.clear()
  clearOAuthState()
})

describe("ConnectorDeepLinkRouter", () => {
  it("does nothing in web mode", async () => {
    mockedIsTauri.mockReturnValue(false)
    render(
      <ConnectorDeepLinkRouter>
        <div>child</div>
      </ConnectorDeepLinkRouter>
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(mockOnDeepLink).not.toHaveBeenCalled()
  })

  it("registers deep-link listener in Tauri mode", async () => {
    mockedIsTauri.mockReturnValue(true)
    render(
      <ConnectorDeepLinkRouter>
        <div>child</div>
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => {
      expect(mockOnDeepLink).toHaveBeenCalledTimes(1)
    })
  })

  it("ignores URLs that don't match the OAuth pattern", async () => {
    mockedIsTauri.mockReturnValue(true)
    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedDeepLinkHandler).not.toBeNull())

    capturedDeepLinkHandler!(["cognia://some/other/path"])
    await new Promise((r) => setTimeout(r, 30))

    expect(mockToastError).not.toHaveBeenCalled()
    expect(mockToastSuccess).not.toHaveBeenCalled()
  })

  it("toasts error on OAuth state mismatch", async () => {
    mockedIsTauri.mockReturnValue(true)
    setOAuthState("correct-state")
    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedDeepLinkHandler).not.toBeNull())

    capturedDeepLinkHandler!(["cognia://connector/oauth/telegram?code=abc123&state=wrong-state"])
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(OAUTH_MESSAGES.stateMismatch)
    })
  })

  it("toasts error when state is missing", async () => {
    mockedIsTauri.mockReturnValue(true)
    // No state stored in sessionStorage
    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedDeepLinkHandler).not.toBeNull())

    capturedDeepLinkHandler!(["cognia://connector/oauth/telegram?code=abc123&state=any-state"])
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(OAUTH_MESSAGES.stateMismatch)
    })
  })

  it("toasts error for unknown adapterType (not in PlatformKind)", async () => {
    mockedIsTauri.mockReturnValue(true)
    setOAuthState("my-state")
    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedDeepLinkHandler).not.toBeNull())

    capturedDeepLinkHandler!(["cognia://connector/oauth/unknownplatform?code=abc&state=my-state"])
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("No sign-in handler for"))
    })
  })

  it("toasts error when platform is known but no handler is registered", async () => {
    mockedIsTauri.mockReturnValue(true)
    setOAuthState("my-state")
    // oauthRegistry is empty — no handler for "slack"
    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedDeepLinkHandler).not.toBeNull())

    capturedDeepLinkHandler!(["cognia://connector/oauth/slack?code=abc&state=my-state"])
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("“slack” doesn't use this sign-in flow.")
    })
  })

  it("invokes registered handler and toasts success", async () => {
    mockedIsTauri.mockReturnValue(true)
    setOAuthState("valid-state")

    const fakeHandler = jest.fn().mockResolvedValue(undefined)
    oauthRegistry.set("slack", fakeHandler)

    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedDeepLinkHandler).not.toBeNull())

    capturedDeepLinkHandler!([
      "cognia://connector/oauth/slack?code=exchange-code&state=valid-state",
    ])
    await waitFor(() => {
      // ADR-0009 v41 / D2 — handler signature gained `state` so platform
      // handlers (Lark first) can decode an adapterId out of it.
      expect(fakeHandler).toHaveBeenCalledWith("exchange-code", "valid-state")
      expect(mockToastSuccess).toHaveBeenCalledWith("slack connected.")
    })
  })

  it("toasts error when registered handler throws", async () => {
    mockedIsTauri.mockReturnValue(true)
    setOAuthState("valid-state")

    const fakeHandler = jest.fn().mockRejectedValue(new Error("token exchange failed"))
    oauthRegistry.set("slack", fakeHandler)

    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedDeepLinkHandler).not.toBeNull())

    capturedDeepLinkHandler!(["cognia://connector/oauth/slack?code=bad-code&state=valid-state"])
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("token exchange failed"))
    })
  })

  it("replays a cold-start desktop launch URL, validating state from durable localStorage", async () => {
    mockedIsTauri.mockReturnValue(true)
    // Cold-start: sessionStorage is empty; only the durable localStorage
    // mirror carries the state (as the relay bounce would leave it).
    localStorage.setItem("connector-oauth-state", "valid-state")
    const fakeHandler = jest.fn().mockResolvedValue(undefined)
    oauthRegistry.set("lark", fakeHandler)
    mockLaunchDeepLink.mockResolvedValue([
      "cognia://connector/oauth/lark?code=cold-code&state=valid-state",
    ])

    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )

    await waitFor(() => {
      expect(fakeHandler).toHaveBeenCalledWith("cold-code", "valid-state")
      expect(mockToastSuccess).toHaveBeenCalledWith("lark connected.")
    })
    // State is cleared on use (both copies).
    expect(sessionStorage.getItem("connector-oauth-state")).toBeNull()
    expect(localStorage.getItem("connector-oauth-state")).toBeNull()
  })

  it("handles connector OAuth callbacks on the Capacitor shell (appUrlOpen)", async () => {
    mockedIsTauri.mockReturnValue(false)
    setCapacitor(true)
    setOAuthState("valid-state")

    const fakeHandler = jest.fn().mockResolvedValue(undefined)
    oauthRegistry.set("slack", fakeHandler)

    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedCapHandler).not.toBeNull())

    const raw = "cognia://connector/oauth/slack?code=exchange-code&state=valid-state"
    capturedCapHandler!({ raw })
    await waitFor(() => {
      expect(fakeHandler).toHaveBeenCalledWith("exchange-code", "valid-state")
      expect(mockToastSuccess).toHaveBeenCalledWith("slack connected.")
    })
    // The in-app browser sheet that hosted the authorize page is dismissed.
    expect(mockCapBrowserClose).toHaveBeenCalled()

    // Same URL again (e.g. launch replay) is deduped.
    capturedCapHandler!({ raw })
    await new Promise((r) => setTimeout(r, 30))
    expect(fakeHandler).toHaveBeenCalledTimes(1)
  })

  it("replays a cold-start connector OAuth launch URL on Capacitor", async () => {
    mockedIsTauri.mockReturnValue(false)
    setCapacitor(true)
    setOAuthState("valid-state")
    const fakeHandler = jest.fn().mockResolvedValue(undefined)
    oauthRegistry.set("slack", fakeHandler)
    mockCapLaunchRoute.mockResolvedValue({
      raw: "cognia://connector/oauth/slack?code=cold-code&state=valid-state",
    })

    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => {
      expect(fakeHandler).toHaveBeenCalledWith("cold-code", "valid-state")
    })
  })

  it("ignores non-connector routes on Capacitor (pair / share / oauth/<provider>)", async () => {
    mockedIsTauri.mockReturnValue(false)
    setCapacitor(true)
    render(
      <ConnectorDeepLinkRouter>
        <div />
      </ConnectorDeepLinkRouter>
    )
    await waitFor(() => expect(capturedCapHandler).not.toBeNull())

    capturedCapHandler!({ raw: "cognia://oauth/claude?code=x" })
    capturedCapHandler!({ raw: "cognia://pair?payload=x" })
    await new Promise((r) => setTimeout(r, 30))
    expect(mockToastError).not.toHaveBeenCalled()
    expect(mockToastSuccess).not.toHaveBeenCalled()
    expect(mockCapBrowserClose).not.toHaveBeenCalled()
  })

  it("renders children", () => {
    mockedIsTauri.mockReturnValue(false)
    const { getByText } = render(
      <ConnectorDeepLinkRouter>
        <span>content</span>
      </ConnectorDeepLinkRouter>
    )
    expect(getByText("content")).toBeTruthy()
  })
})
