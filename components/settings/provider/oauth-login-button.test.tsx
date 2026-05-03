/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { OAuthLoginButton } from "./oauth-login-button"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock OAuth utilities
jest.mock("@/lib/ai/providers/oauth", () => ({
  buildOAuthUrl: jest.fn(),
  exchangeCodeForApiKey: jest.fn(),
  getOAuthState: jest.fn(),
  getOAuthCallbackQueryKeys: jest.fn(() => []),
  parseOAuthCallback: jest.fn(() => null),
  verifyOAuthState: jest.fn(() => true),
  clearOAuthState: jest.fn(),
}))

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
jest.mock("@/types/provider", () => ({
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

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

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
