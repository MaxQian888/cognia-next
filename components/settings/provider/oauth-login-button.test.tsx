/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { OAuthLoginButton } from "./oauth-login-button"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock OAuth utilities
const mockBuildOAuthUrl = jest.fn()
const mockExchangeCodeForApiKey = jest.fn()
const mockGetOAuthState = jest.fn()
const mockParseOAuthCallback = jest.fn(() => null as Record<string, string | null> | null)
jest.mock("@cognia/provider-core/providers/oauth", () => ({
  buildOAuthUrl: (...args: unknown[]) => mockBuildOAuthUrl(...args),
  buildNativeOAuthRedirectUri: (id: string) => `cognia://provider/oauth/${id}`,
  parseNativeOAuthDeepLink: (raw: string) => {
    const m = /^cognia:\/\/provider\/oauth\/([^?#/]+)/.exec(raw)
    if (!m) return null
    const url = new URL(raw.replace(/^cognia:\/\//, "https://x/"))
    return { providerId: m[1], search: url.searchParams }
  },
  exchangeCodeForApiKey: (...args: unknown[]) => mockExchangeCodeForApiKey(...args),
  getOAuthState: () => mockGetOAuthState(),
  getOAuthCallbackQueryKeys: jest.fn(() => ["code", "error", "state"]),
  parseOAuthCallback: () => mockParseOAuthCallback(),
  verifyOAuthState: jest.fn(() => true),
  clearOAuthState: jest.fn(),
}))

// Host detection + native plumbing
let mockIsTauri = false
let mockIsCapacitor = false
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("@/lib/platform/detect", () => ({ isCapacitor: () => mockIsCapacitor }))
const mockOpenUrl = jest.fn(async (_url: string) => undefined)
jest.mock("@/lib/native/opener", () => ({ openUrl: (url: string) => mockOpenUrl(url) }))
let deepLinkHandler: ((urls: string[]) => void) | null = null
jest.mock("@/lib/tauri/deep-link", () => ({
  getLaunchDeepLink: async () => null,
  onDeepLink: async (handler: (urls: string[]) => void) => {
    deepLinkHandler = handler
    return () => {
      deepLinkHandler = null
    }
  },
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({
  safeUnlisten: (fn: (() => void) | null) => fn?.(),
}))
jest.mock("@/lib/capacitor/deeplink", () => ({
  getLaunchRoute: async () => null,
  subscribe: async () => () => {},
}))
jest.mock("@/lib/capacitor/browser", () => ({ close: async () => undefined }))

// Mock stores
const mockUpdateProviderSettings = jest.fn()
const mockState = {
  providerSettings: {
    openrouter: { apiKey: "", oauthConnected: false },
    openrouterConnected: {
      apiKey: "test-key",
      oauthConnected: true,
      oauthExpiresAt: Date.now() + 86400000,
    },
    openrouterExpired: {
      apiKey: "test-key",
      oauthConnected: true,
      oauthExpiresAt: Date.now() - 86400000,
    },
    openrouterExpiringSoon: {
      apiKey: "test-key",
      oauthConnected: true,
      oauthExpiresAt: Date.now() + 3600000,
    },
  },
}

jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      providerSettings: mockState.providerSettings,
      updateProviderSettings: mockUpdateProviderSettings,
    }
    return selector(state)
  },
}))

// Mock providers
jest.mock("@cognia/provider-types", () => ({
  PROVIDERS: {
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      supportsOAuth: true,
    },
    openrouterConnected: {
      id: "openrouterConnected",
      name: "OpenRouter",
      supportsOAuth: true,
    },
    openrouterExpired: {
      id: "openrouterExpired",
      name: "OpenRouter",
      supportsOAuth: true,
    },
    openrouterExpiringSoon: {
      id: "openrouterExpiringSoon",
      name: "OpenRouter",
      supportsOAuth: true,
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      supportsOAuth: false,
    },
  },
}))

// Mock cn utility
jest.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

// Mock UI components
jest.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled} data-testid="oauth-button">
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/tooltip")

describe("OAuthLoginButton", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders for OAuth-supporting provider", () => {
    render(<OAuthLoginButton providerId="openrouter" />)
    expect(screen.getByTestId("oauth-button")).toBeInTheDocument()
  })

  it("does not render for non-OAuth provider", () => {
    render(<OAuthLoginButton providerId="openai" />)
    expect(screen.queryByTestId("oauth-button")).not.toBeInTheDocument()
  })

  it("displays login text", () => {
    render(<OAuthLoginButton providerId="openrouter" />)
    expect(screen.getByText("oauthLogin")).toBeInTheDocument()
  })

  it("handles login click", async () => {
    const { unmount } = render(<OAuthLoginButton providerId="openrouter" />)
    const button = screen.getByTestId("oauth-button")
    expect(button).toBeInTheDocument()
    // Unmount to prevent state updates after test ends
    unmount()
  })

  it("on the web, redirects with the route-based callback and finishes from the query string", async () => {
    mockIsTauri = false
    mockIsCapacitor = false
    mockBuildOAuthUrl.mockResolvedValue({ url: "https://openrouter.ai/auth?x=1", state: {} })
    const navigate = jest.fn()
    try {
      const { unmount } = render(<OAuthLoginButton providerId="openrouter" navigate={navigate} />)
      fireEvent.click(screen.getByTestId("oauth-button"))
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://openrouter.ai/auth?x=1"))
      // No native redirect URI on the web — the catalog's route-based default is used.
      expect(mockBuildOAuthUrl).toHaveBeenCalledWith("openrouter", { redirectUri: undefined })
      unmount()

      // Callback landing: `?oauthProvider=openrouter&code=abc` → exchange → save key.
      window.history.pushState(
        {},
        "",
        "/settings?section=providers&oauthProvider=openrouter&code=abc"
      )
      mockParseOAuthCallback.mockReturnValue({ code: "abc", error: null, state: null })
      mockGetOAuthState.mockReturnValue({ providerId: "openrouter", codeVerifier: "ver" })
      mockExchangeCodeForApiKey.mockResolvedValue({ apiKey: "sk-or-new" })
      render(<OAuthLoginButton providerId="openrouter" />)
      await waitFor(() =>
        expect(mockUpdateProviderSettings).toHaveBeenCalledWith(
          "openrouter",
          expect.objectContaining({ apiKey: "sk-or-new", oauthConnected: true, enabled: true })
        )
      )
      expect(mockExchangeCodeForApiKey).toHaveBeenCalledWith("openrouter", {
        code: "abc",
        codeVerifier: "ver",
      })
      // The one-shot callback params are scrubbed from the address bar.
      expect(window.location.search).not.toContain("code=")
      expect(window.location.search).not.toContain("oauthProvider=")
    } finally {
      window.history.pushState({}, "", "/")
      mockParseOAuthCallback.mockReturnValue(null)
    }
  })

  it("ignores a web callback addressed to a different provider", async () => {
    window.history.pushState({}, "", "/settings?oauthProvider=someone-else&code=abc")
    try {
      mockParseOAuthCallback.mockReturnValue({ code: "abc", error: null, state: null })
      render(<OAuthLoginButton providerId="openrouter" />)
      await new Promise((r) => setTimeout(r, 0))
      expect(mockExchangeCodeForApiKey).not.toHaveBeenCalled()
    } finally {
      window.history.pushState({}, "", "/")
      mockParseOAuthCallback.mockReturnValue(null)
    }
  })

  it("on the desktop, opens the system browser with the cognia:// redirect and finishes from the deep link", async () => {
    mockIsTauri = true
    try {
      mockBuildOAuthUrl.mockResolvedValue({ url: "https://openrouter.ai/auth?native=1", state: {} })
      mockGetOAuthState.mockReturnValue({ providerId: "openrouter", codeVerifier: "ver" })
      mockExchangeCodeForApiKey.mockResolvedValue({ apiKey: "sk-or-native" })
      render(<OAuthLoginButton providerId="openrouter" />)
      await waitFor(() => expect(deepLinkHandler).not.toBeNull())
      fireEvent.click(screen.getByTestId("oauth-button"))
      await waitFor(() =>
        expect(mockOpenUrl).toHaveBeenCalledWith("https://openrouter.ai/auth?native=1")
      )
      expect(mockBuildOAuthUrl).toHaveBeenCalledWith("openrouter", {
        redirectUri: "cognia://provider/oauth/openrouter",
      })
      // The IdP redirects to the deep link; the plugin hands it to the renderer.
      deepLinkHandler?.(["cognia://provider/oauth/openrouter?code=native-code"])
      await waitFor(() =>
        expect(mockUpdateProviderSettings).toHaveBeenCalledWith(
          "openrouter",
          expect.objectContaining({ apiKey: "sk-or-native", oauthConnected: true })
        )
      )
      // A deep link for another provider is ignored by this button.
      mockUpdateProviderSettings.mockClear()
      deepLinkHandler?.(["cognia://provider/oauth/other?code=x"])
      await new Promise((r) => setTimeout(r, 0))
      expect(mockUpdateProviderSettings).not.toHaveBeenCalled()
    } finally {
      mockIsTauri = false
    }
  })

  it("does not render for unknown provider", () => {
    render(<OAuthLoginButton providerId="unknown" />)
    expect(screen.queryByTestId("oauth-button")).not.toBeInTheDocument()
  })

  it("renders with default variant", () => {
    render(<OAuthLoginButton providerId="openrouter" />)
    expect(screen.getByTestId("oauth-button")).toBeInTheDocument()
  })

  it("renders with custom size", () => {
    render(<OAuthLoginButton providerId="openrouter" size="lg" />)
    expect(screen.getByTestId("oauth-button")).toBeInTheDocument()
  })

  it("renders with custom className", () => {
    render(<OAuthLoginButton providerId="openrouter" className="custom-class" />)
    expect(screen.getByTestId("oauth-button")).toBeInTheDocument()
  })

  it("shows connected state for OAuth-connected provider", () => {
    render(<OAuthLoginButton providerId="openrouterConnected" />)
    expect(screen.getByTestId("oauth-button")).toBeInTheDocument()
  })

  it("shows expired state for expired OAuth token", () => {
    render(<OAuthLoginButton providerId="openrouterExpired" />)
    expect(screen.getByTestId("oauth-button")).toBeInTheDocument()
  })

  it("shows warning state for soon-to-expire OAuth token", () => {
    render(<OAuthLoginButton providerId="openrouterExpiringSoon" />)
    expect(screen.getByTestId("oauth-button")).toBeInTheDocument()
  })
})
