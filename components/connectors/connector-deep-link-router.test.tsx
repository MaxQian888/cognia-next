/**
 * @jest-environment jsdom
 *
 * Task 42 — ConnectorDeepLinkRouter.
 *
 * Covers:
 *  - Web mode: onDeepLink not called.
 *  - Tauri mode, unknown path: handler not invoked.
 *  - Tauri mode, state mismatch: toast.error("OAuth state mismatch").
 *  - Tauri mode, unknown adapterType: toast.error("No OAuth handler for X").
 *  - Tauri mode, registered handler: handler invoked, toast.success.
 *  - Tauri mode, handler throws: toast.error with error message.
 */

import { render, waitFor } from "@testing-library/react"
import { ConnectorDeepLinkRouter } from "./connector-deep-link-router"
import { isTauri } from "@/lib/tauri"
import { oauthRegistry } from "@/lib/connectors/oauth-registry"

// ── Mock isTauri ─────────────────────────────────────────────────────────────
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

// ── Mock deep-link ────────────────────────────────────────────────────────────
let capturedDeepLinkHandler: ((urls: string[]) => void) | null = null
const mockOnDeepLink = jest.fn().mockImplementation(async (handler: (urls: string[]) => void) => {
  capturedDeepLinkHandler = handler
  return jest.fn() // unsubscribe fn
})
jest.mock("@/lib/tauri/deep-link", () => ({
  onDeepLink: (...args: unknown[]) => mockOnDeepLink(...args),
}))

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
}

beforeEach(() => {
  jest.clearAllMocks()
  capturedDeepLinkHandler = null
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
      expect(mockToastError).toHaveBeenCalledWith("OAuth state mismatch")
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
      expect(mockToastError).toHaveBeenCalledWith("OAuth state mismatch")
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
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("No OAuth handler for unknown platform")
      )
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
      expect(mockToastError).toHaveBeenCalledWith("No OAuth handler for slack")
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
      expect(mockToastSuccess).toHaveBeenCalledWith("slack connected successfully")
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
