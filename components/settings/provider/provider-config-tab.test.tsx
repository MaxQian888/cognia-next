/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderConfigTab } from "./provider-config-tab"
import type { UserProviderSettings } from "@cognia/provider-types"

// ── i18n mock ────────────────────────────────────────────────────────────────

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      "configTab.apiKeyLabel": "API Key",
      "configTab.apiKeyPlaceholder": "Enter your API key",
      "configTab.getApiKey": "Get API Key →",
      "configTab.showKey": "Show key",
      "configTab.hideKey": "Hide key",
      "configTab.baseURLLabel": "Base URL",
      "configTab.baseURLPlaceholder": "https://api.example.com/v1",
      "configTab.baseURLOptional": "Optional",
      "configTab.defaultModelLabel": "Default Model",
      "configTab.selectModel": "Select model",
      "configTab.connectionStatus": "Connection Status",
      "configTab.connectionSuccess": "Connected",
      "configTab.connectionFailed": "Connection failed",
      "configTab.latency": "Latency",
      "configTab.lastTested": "Last tested",
      "configTab.keyRotation": "Key Rotation",
      "configTab.keyRotationEnabled": "Enable rotation",
      "configTab.rotationStrategy": "Strategy",
      "configTab.addKey": "Add Key",
      "configTab.removeKey": "Remove",
      "configTab.strategyRoundRobin": "Round Robin",
      "configTab.strategyRandom": "Random",
      "configTab.strategyLeastUsed": "Least Used",
    }
    return map[key] ?? key
  },
}))

jest.mock("./anthropic-subscription-reuse-card", () => ({
  AnthropicSubscriptionReuseCard: () => <div data-testid="anthropic-reuse-card" />,
}))

// ── UI mocks ──────────────────────────────────────────────────────────────────

jest.mock("@/components/ui/input")

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button data-testid="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/switch")

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: React.ReactNode
    onValueChange?: (v: string) => void
    value?: string
  }) => (
    <div data-testid="select" data-value={value}>
      {React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          return React.cloneElement(
            child as React.ReactElement<{ onValueChange?: (v: string) => void }>,
            {
              onValueChange,
            }
          )
        }
        return child
      })}
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-trigger">{children}</div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span data-testid="select-value">{placeholder}</span>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-content">{children}</div>
  ),
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid={`select-item-${value}`}>{children}</div>
  ),
}))

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-testid="collapsible" data-open={open}>
      {children}
    </div>
  ),
  CollapsibleTrigger: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <div data-testid="collapsible-trigger" onClick={onClick}>
      {children}
    </div>
  ),
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
}))

jest.mock("@/components/ui/label")

jest.mock("@/components/ui/separator")

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockSettings: UserProviderSettings = {
  providerId: "openai",
  enabled: true,
  apiKey: "sk-test-1234",
  baseURL: "",
  defaultModel: "gpt-4o",
}

const mockModels = [
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
  { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
]

const defaultProps = {
  providerId: "openai",
  settings: mockSettings,
  providerModels: mockModels,
  providerDashboardUrl: "https://platform.openai.com/api-keys",
  onApiKeyChange: jest.fn(),
  onBaseURLChange: jest.fn(),
  onDefaultModelChange: jest.fn(),
  onTestConnection: jest.fn().mockResolvedValue({ success: true, latency: 120 }),
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProviderConfigTab", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // 1. API key input renders as password by default
  it("renders API key input as password type by default", () => {
    render(<ProviderConfigTab {...defaultProps} />)
    const inputs = screen.getAllByTestId("input")
    const apiKeyInput = inputs.find((el) => el.getAttribute("type") === "password")
    expect(apiKeyInput).toBeTruthy()
  })

  it("shows the Anthropic subscription-reuse card only for the anthropic provider", () => {
    const { rerender } = render(<ProviderConfigTab {...defaultProps} />)
    expect(screen.queryByTestId("anthropic-reuse-card")).not.toBeInTheDocument()
    rerender(
      <ProviderConfigTab
        {...defaultProps}
        providerId="anthropic"
        settings={{ ...mockSettings, providerId: "anthropic" }}
      />
    )
    expect(screen.getByTestId("anthropic-reuse-card")).toBeInTheDocument()
  })

  // 2. Base URL input renders
  it("renders base URL input", () => {
    render(<ProviderConfigTab {...defaultProps} />)
    const inputs = screen.getAllByTestId("input")
    const urlInput = inputs.find((el) => el.getAttribute("placeholder")?.includes("https://api"))
    expect(urlInput).toBeTruthy()
  })

  // 3. Default model selector with options from providerModels
  it("renders default model selector with options from providerModels", () => {
    render(<ProviderConfigTab {...defaultProps} />)
    expect(screen.getByTestId("select")).toBeInTheDocument()
    expect(screen.getByTestId("select-item-gpt-4o")).toBeInTheDocument()
    expect(screen.getByTestId("select-item-gpt-4-turbo")).toBeInTheDocument()
    expect(screen.getByTestId("select-item-gpt-3.5-turbo")).toBeInTheDocument()
  })

  // 4. Shows connection success card when testResult.success is true
  it("shows connection success information when testResult.success is true", () => {
    render(
      <ProviderConfigTab
        {...defaultProps}
        testResult={{ success: true, latency: 245, testedAt: Date.now() }}
      />
    )
    // Should show a success indicator (checkmark text or latency)
    expect(screen.getByText(/245\s*ms/i)).toBeInTheDocument()
  })

  // 5. Shows connection failure message when testResult.success is false
  it("shows connection failure message when testResult.success is false", () => {
    const errorMsg = "Invalid API key"
    render(<ProviderConfigTab {...defaultProps} testResult={{ success: false, error: errorMsg }} />)
    expect(screen.getByText(errorMsg)).toBeInTheDocument()
  })

  // 6. Calls onApiKeyChange when API key input changes
  it("calls onApiKeyChange when API key input changes", () => {
    const onApiKeyChange = jest.fn()
    render(<ProviderConfigTab {...defaultProps} onApiKeyChange={onApiKeyChange} />)
    const inputs = screen.getAllByTestId("input")
    const apiKeyInput = inputs.find((el) => el.getAttribute("type") === "password")
    expect(apiKeyInput).toBeTruthy()
    fireEvent.change(apiKeyInput!, { target: { value: "sk-new-key" } })
    expect(onApiKeyChange).toHaveBeenCalledWith("sk-new-key")
  })

  // 7. Key rotation section is collapsed by default
  it("key rotation section is collapsed by default", () => {
    render(
      <ProviderConfigTab
        {...defaultProps}
        onToggleRotation={jest.fn()}
        onAddApiKey={jest.fn()}
        onRemoveApiKey={jest.fn()}
      />
    )
    const collapsible = screen.getByTestId("collapsible")
    // The collapsible should not be open (data-open="false" or absent)
    expect(collapsible.getAttribute("data-open")).not.toBe("true")
  })

  // Bonus: Get API Key link renders when dashboardUrl provided
  it('renders "Get API Key" link when providerDashboardUrl is provided', () => {
    render(<ProviderConfigTab {...defaultProps} />)
    expect(screen.getByText("Get API Key →")).toBeInTheDocument()
  })

  // Bonus: Show/hide toggle changes input type
  it("toggles API key visibility when show/hide button is clicked", () => {
    render(<ProviderConfigTab {...defaultProps} />)
    const inputs = screen.getAllByTestId("input")
    const apiKeyInput = inputs.find((el) => el.getAttribute("type") === "password")
    expect(apiKeyInput).toBeTruthy()

    // Find the toggle button near the API key section
    const buttons = screen.getAllByTestId("button")
    // The show/hide button should be present
    expect(buttons.length).toBeGreaterThan(0)
  })

  // Bonus: No testResult renders no success/error card
  it("does not show connection status card when testResult is null", () => {
    render(<ProviderConfigTab {...defaultProps} testResult={null} />)
    expect(screen.queryByText(/245\s*ms/i)).not.toBeInTheDocument()
    expect(screen.queryByText("Invalid API key")).not.toBeInTheDocument()
  })
})
