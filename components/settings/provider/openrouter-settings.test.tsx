/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { OpenRouterSettings } from "./openrouter-settings"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      "openrouterSettings.credits": "OpenRouter Credits",
      "openrouterSettings.total": "Total",
      "openrouterSettings.used": "Used",
      "openrouterSettings.remaining": "Remaining",
      clickRefreshToLoad: "Click refresh to load credits",
      availableModels: "Available Models",
      modelsAvailableThrough: "Models available through this provider",
      "openrouterSettings.byok": "Bring Your Own Keys (BYOK)",
      "openrouterSettings.byokDescription": "Configure provider keys",
      "openrouterSettings.addProviderKey": "Add Provider Key",
      "openrouterSettings.addKey": "Add Key",
      "openrouterSettings.learnMoreByok": "Learn more about BYOK",
      "openrouterSettings.alwaysUse": "Always Use",
      "openrouterSettings.alwaysUseHint": "Prefer this provider key whenever it is available.",
      "openrouterSettings.providerOrdering": "Provider Ordering",
      "openrouterSettings.providerOrderingDescription": "Control provider priority",
      "openrouterSettings.enableProviderOrdering": "Enable Provider Ordering",
      "openrouterSettings.allowFallbacks": "Allow Fallbacks",
      "openrouterSettings.allowFallbacksDesc": "Allow fallback providers",
      "openrouterSettings.providerOrder": "Provider Order",
      "openrouterSettings.providerOrderHint": "Comma-separated order hint",
      "openrouterSettings.appAttribution": "App Attribution",
      "openrouterSettings.appAttributionDesc": "Optional leaderboard attribution",
      "openrouterSettings.siteUrl": "Site URL",
      "openrouterSettings.siteName": "Site Name",
      active: "Active",
    }
    return translations[key] || key
  },
}))

// Mock nanoid
jest.mock("nanoid", () => ({
  nanoid: () => "test-id-123",
}))

// Mock stores
const mockUpdateProviderSettings = jest.fn()
let mockSettings: {
  enabled: boolean
  apiKey: string
  openRouterSettings: Record<string, unknown>
} = {
  enabled: true,
  apiKey: "test-api-key",
  openRouterSettings: {
    credits: 10.0,
    creditsUsed: 2.0,
    creditsRemaining: 8.0,
    byokKeys: [],
    providerOrdering: { enabled: false, allowFallbacks: true, order: [] },
  },
}

jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      providerSettings: {
        openrouter: mockSettings,
      },
      updateProviderSettings: mockUpdateProviderSettings,
    }
    return selector(state)
  },
}))

// Mock openrouter lib
const mockGetCredits = jest.fn()
const mockDiscoverOpenRouterModels = jest.fn()

jest.mock("@cognia/provider-core/providers/openrouter", () => ({
  getCredits: (...args: unknown[]) => mockGetCredits(...args),
  formatCredits: (credits: number) => `$${credits.toFixed(2)}`,
  maskApiKey: (key: string) => `${key.slice(0, 4)}...${key.slice(-4)}`,
  OpenRouterError: class extends Error {},
}))

jest.mock("@cognia/provider-core/providers/model-discovery", () => ({
  discoverOpenRouterModels: (...args: unknown[]) => mockDiscoverOpenRouterModels(...args),
}))

// Mock UI components
jest.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled} data-testid="button">
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/input")

jest.mock("@/components/ui/label")

jest.mock("@/components/ui/switch")

jest.mock("@/components/ui/textarea")

jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select">{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>Value</span>,
}))

jest.mock("@/components/ui/collapsible")

jest.mock("@/components/ui/card")

jest.mock("@/components/ui/tooltip")

jest.mock("@/components/ui/badge")

jest.mock("@/components/ui/separator")

describe("OpenRouterSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetCredits.mockResolvedValue({
      credits: 10,
      credits_used: 2,
      credits_remaining: 8,
    })
    mockSettings = {
      enabled: true,
      apiKey: "test-api-key",
      openRouterSettings: {
        credits: 10.0,
        creditsUsed: 2.0,
        creditsRemaining: 8.0,
        creditsLastFetched: 123,
        byokKeys: [],
        providerOrdering: { enabled: false, allowFallbacks: true, order: [] },
      },
    }
  })

  it("renders nothing when provider is disabled", () => {
    mockSettings = { ...mockSettings, enabled: false }
    const { container } = render(<OpenRouterSettings />)
    expect(container.firstChild).toBeNull()
  })

  it("renders credits card when enabled", () => {
    render(<OpenRouterSettings />)
    expect(screen.getByText("OpenRouter Credits")).toBeInTheDocument()
  })

  it("displays credits information", () => {
    render(<OpenRouterSettings />)
    expect(screen.getByText("Total")).toBeInTheDocument()
    expect(screen.getByText("Used")).toBeInTheDocument()
    expect(screen.getByText("Remaining")).toBeInTheDocument()
  })

  it("shows refresh button for credits", () => {
    render(<OpenRouterSettings />)
    const buttons = screen.getAllByTestId("button")
    expect(buttons.length).toBeGreaterThan(0)
  })

  it("displays BYOK section", () => {
    render(<OpenRouterSettings />)
    expect(screen.getByText("Bring Your Own Keys (BYOK)")).toBeInTheDocument()
  })

  it("displays provider ordering section", () => {
    render(<OpenRouterSettings />)
    expect(screen.getByText("Provider Ordering")).toBeInTheDocument()
  })

  it("displays app attribution section", () => {
    render(<OpenRouterSettings />)
    expect(screen.getByText("App Attribution")).toBeInTheDocument()
  })

  it("shows site URL input", () => {
    render(<OpenRouterSettings />)
    expect(screen.getByText("Site URL")).toBeInTheDocument()
  })

  it("shows site name input", () => {
    render(<OpenRouterSettings />)
    expect(screen.getByText("Site Name")).toBeInTheDocument()
  })

  it("applies custom className", () => {
    render(<OpenRouterSettings className="custom-class" />)
    const cards = screen.getAllByTestId("card")
    expect(cards.length).toBeGreaterThan(0)
  })

  it("persists discovered models through the shared discovery cache when refresh is clicked", async () => {
    mockDiscoverOpenRouterModels.mockResolvedValue([
      {
        id: "openai/o3",
        name: "OpenAI o3",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ])

    render(<OpenRouterSettings />)
    fireEvent.click(screen.getAllByTestId("button")[1])

    await waitFor(() => {
      expect(mockDiscoverOpenRouterModels).toHaveBeenCalledWith("test-api-key")
    })
    expect(mockUpdateProviderSettings).toHaveBeenCalledWith(
      "openrouter",
      expect.objectContaining({
        discoveredModels: [
          expect.objectContaining({
            id: "openai/o3",
            name: "OpenAI o3",
          }),
        ],
        discoveredModelsLastFetched: expect.any(Number),
      })
    )
  })
})

describe("OpenRouterSettings BYOK", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetCredits.mockResolvedValue({
      credits: 10,
      credits_used: 2,
      credits_remaining: 8,
    })
    mockSettings = {
      enabled: true,
      apiKey: "test-api-key",
      openRouterSettings: {
        credits: 10.0,
        creditsLastFetched: 123,
        byokKeys: [
          { id: "key1", provider: "openai", config: "sk-test", enabled: true, alwaysUse: false },
        ],
        providerOrdering: { enabled: false, allowFallbacks: true, order: [] },
      },
    }
  })

  it("displays existing BYOK keys", () => {
    render(<OpenRouterSettings />)
    const badges = screen.getAllByTestId("badge")
    expect(badges.length).toBeGreaterThan(0)
  })

  it("shows add provider key section", () => {
    render(<OpenRouterSettings />)
    expect(screen.getByText("Add Provider Key")).toBeInTheDocument()
  })

  it("shows provider select dropdown", () => {
    render(<OpenRouterSettings />)
    const selects = screen.getAllByTestId("select")
    expect(selects.length).toBeGreaterThan(0)
  })
})

describe("OpenRouterSettings error handling", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetCredits.mockResolvedValue({
      credits: 10,
      credits_used: 2,
      credits_remaining: 8,
    })
    mockSettings = {
      enabled: true,
      apiKey: "test-api-key",
      openRouterSettings: {
        creditsLastFetched: 123,
      },
    }
  })

  it("renders error handling UI", () => {
    render(<OpenRouterSettings />)
    const cards = screen.getAllByTestId("card")
    expect(cards.length).toBeGreaterThan(0)
  })

  it("shows placeholder when credits not fetched", () => {
    mockSettings = {
      enabled: true,
      apiKey: "test-api-key",
      openRouterSettings: {
        creditsLastFetched: 123,
      },
    }
    render(<OpenRouterSettings />)
    expect(screen.getAllByText("Click refresh to load credits").length).toBeGreaterThan(0)
  })
})
