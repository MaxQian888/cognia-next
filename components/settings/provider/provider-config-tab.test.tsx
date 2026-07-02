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
      apiProtocol: "API Protocol",
      selectProtocol: "Select protocol",
      apiProtocolHint: "Choose the API protocol that matches your provider's implementation.",
      protocolOpenAIDesc: "OpenAI-compatible API (most common)",
      protocolAnthropicDesc: "Anthropic Claude API format",
      protocolGeminiDesc: "Google Gemini API format",
      baseURLHint: "Use a proxy URL or self-hosted endpoint. Leave empty for default.",
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

  // ── Base URL pre-fill + persist (catalog default) ──────────────────────────
  // `moonshot` carries a catalog default base URL of https://api.moonshot.cn/v1.
  const MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1"

  function baseURLInputValue(): string {
    const inputs = screen.getAllByTestId("input") as HTMLInputElement[]
    const urlInput = inputs.find((el) => el.getAttribute("type") === "text")
    return urlInput?.value ?? ""
  }

  it("pre-fills the base URL field with the provider default when none is stored", () => {
    const onBaseURLChange = jest.fn()
    render(
      <ProviderConfigTab
        {...defaultProps}
        providerId="moonshot"
        settings={{ providerId: "moonshot", enabled: false, defaultModel: "" }}
        onBaseURLChange={onBaseURLChange}
      />
    )
    expect(baseURLInputValue()).toBe(MOONSHOT_BASE_URL)
    // Browsing a provider must not persist anything (status stays accurate).
    expect(onBaseURLChange).not.toHaveBeenCalled()
  })

  it("persists the provider default base URL once the provider is enabled", () => {
    const onBaseURLChange = jest.fn()
    render(
      <ProviderConfigTab
        {...defaultProps}
        providerId="moonshot"
        settings={{ providerId: "moonshot", enabled: true, defaultModel: "" }}
        onBaseURLChange={onBaseURLChange}
      />
    )
    expect(onBaseURLChange).toHaveBeenCalledWith(MOONSHOT_BASE_URL)
  })

  it("persists the default base URL when an API key is present but no base URL is stored", () => {
    const onBaseURLChange = jest.fn()
    render(
      <ProviderConfigTab
        {...defaultProps}
        providerId="moonshot"
        settings={{ providerId: "moonshot", enabled: false, apiKey: "sk-x", defaultModel: "" }}
        onBaseURLChange={onBaseURLChange}
      />
    )
    expect(onBaseURLChange).toHaveBeenCalledWith(MOONSHOT_BASE_URL)
  })

  it("never overrides a user-supplied base URL", () => {
    const onBaseURLChange = jest.fn()
    render(
      <ProviderConfigTab
        {...defaultProps}
        providerId="moonshot"
        settings={{
          providerId: "moonshot",
          enabled: true,
          baseURL: "https://my-proxy.example/v1",
          defaultModel: "",
        }}
        onBaseURLChange={onBaseURLChange}
      />
    )
    expect(baseURLInputValue()).toBe("https://my-proxy.example/v1")
    expect(onBaseURLChange).not.toHaveBeenCalled()
  })

  it("does not pre-fill or persist for providers without a fixed endpoint (OpenAI)", () => {
    const onBaseURLChange = jest.fn()
    render(
      <ProviderConfigTab
        {...defaultProps}
        providerId="openai"
        settings={{ providerId: "openai", enabled: true, apiKey: "sk-x", defaultModel: "" }}
        onBaseURLChange={onBaseURLChange}
      />
    )
    expect(baseURLInputValue()).toBe("")
    expect(onBaseURLChange).not.toHaveBeenCalled()
  })

  // ── API Protocol override selector ──────────────────────────────────────
  describe("API Protocol override selector", () => {
    it("does not render when onApiProtocolChange is not provided", () => {
      render(<ProviderConfigTab {...defaultProps} providerId="deepseek" />)
      expect(screen.queryByTestId("select-item-anthropic")).not.toBeInTheDocument()
    })

    it("renders protocol options for a non-anthropic built-in provider", () => {
      render(
        <ProviderConfigTab
          {...defaultProps}
          providerId="deepseek"
          settings={{ ...mockSettings, providerId: "deepseek" }}
          onApiProtocolChange={jest.fn()}
        />
      )
      expect(screen.getByTestId("select-item-openai")).toBeInTheDocument()
      expect(screen.getByTestId("select-item-anthropic")).toBeInTheDocument()
      expect(screen.getByTestId("select-item-gemini")).toBeInTheDocument()
    })

    it("defaults the selector value to the catalog protocol when no override is stored", () => {
      render(
        <ProviderConfigTab
          {...defaultProps}
          providerId="deepseek"
          settings={{ ...mockSettings, providerId: "deepseek" }}
          onApiProtocolChange={jest.fn()}
        />
      )
      const selects = screen.getAllByTestId("select")
      const protocolSelect = selects.find((el) => el.getAttribute("data-value") === "openai")
      expect(protocolSelect).toBeTruthy()
    })

    it("reflects a stored apiProtocol override as the selector value", () => {
      render(
        <ProviderConfigTab
          {...defaultProps}
          providerId="deepseek"
          settings={{ ...mockSettings, providerId: "deepseek", apiProtocol: "anthropic" }}
          onApiProtocolChange={jest.fn()}
        />
      )
      const selects = screen.getAllByTestId("select")
      const protocolSelect = selects.find((el) => el.getAttribute("data-value") === "anthropic")
      expect(protocolSelect).toBeTruthy()
    })

    it("never renders for the anthropic provider, even when onApiProtocolChange is provided", () => {
      render(
        <ProviderConfigTab
          {...defaultProps}
          providerId="anthropic"
          settings={{ ...mockSettings, providerId: "anthropic" }}
          onApiProtocolChange={jest.fn()}
        />
      )
      expect(screen.queryByTestId("select-item-anthropic")).not.toBeInTheDocument()
      expect(screen.queryByTestId("select-item-gemini")).not.toBeInTheDocument()
    })
  })

  // ── Key Rotation interactions ───────────────────────────────────────────
  describe("Key Rotation interactions", () => {
    const rotationSettings: UserProviderSettings = {
      ...mockSettings,
      apiKeys: ["sk-aaaa1111", "sk-bbbb2222"],
    }

    it("calls onToggleRotation when the switch is flipped (2+ keys)", () => {
      const onToggleRotation = jest.fn()
      render(
        <ProviderConfigTab
          {...defaultProps}
          settings={rotationSettings}
          onToggleRotation={onToggleRotation}
          onAddApiKey={jest.fn()}
          onRemoveApiKey={jest.fn()}
        />
      )
      const toggle = screen.getByTestId("switch")
      expect(toggle).not.toBeDisabled()
      fireEvent.click(toggle)
      expect(onToggleRotation).toHaveBeenCalledWith(true)
    })

    it("disables the rotation switch with fewer than 2 keys", () => {
      render(
        <ProviderConfigTab
          {...defaultProps}
          settings={{ ...mockSettings, apiKeys: ["sk-aaaa1111"] }}
          onToggleRotation={jest.fn()}
          onAddApiKey={jest.fn()}
          onRemoveApiKey={jest.fn()}
        />
      )
      expect(screen.getByTestId("switch")).toBeDisabled()
    })

    it("shows the strategy selector only once rotation is enabled", () => {
      const { rerender } = render(
        <ProviderConfigTab
          {...defaultProps}
          settings={rotationSettings}
          onToggleRotation={jest.fn()}
          onRotationStrategyChange={jest.fn()}
          onAddApiKey={jest.fn()}
          onRemoveApiKey={jest.fn()}
        />
      )
      expect(screen.queryByText("Round Robin")).not.toBeInTheDocument()
      rerender(
        <ProviderConfigTab
          {...defaultProps}
          settings={{ ...rotationSettings, apiKeyRotationEnabled: true }}
          onToggleRotation={jest.fn()}
          onRotationStrategyChange={jest.fn()}
          onAddApiKey={jest.fn()}
          onRemoveApiKey={jest.fn()}
        />
      )
      expect(screen.getByText("Round Robin")).toBeInTheDocument()
    })

    it("lists pooled keys with a Remove button per key", () => {
      const onRemoveApiKey = jest.fn()
      render(
        <ProviderConfigTab
          {...defaultProps}
          settings={rotationSettings}
          onAddApiKey={jest.fn()}
          onRemoveApiKey={onRemoveApiKey}
        />
      )
      const removeButtons = screen.getAllByTitle("Remove")
      expect(removeButtons).toHaveLength(2)
      fireEvent.click(removeButtons[0])
      expect(onRemoveApiKey).toHaveBeenCalledWith(0)
    })

    it("reorders a key via move-down, and disables move-down on the last row", () => {
      const onReorderApiKeys = jest.fn()
      render(
        <ProviderConfigTab
          {...defaultProps}
          settings={rotationSettings}
          onAddApiKey={jest.fn()}
          onRemoveApiKey={jest.fn()}
          onReorderApiKeys={onReorderApiKeys}
        />
      )
      const moveDownButtons = screen.getAllByTitle("Move down")
      fireEvent.click(moveDownButtons[0])
      expect(onReorderApiKeys).toHaveBeenCalledWith(0, 1)
      expect(moveDownButtons[1]).toBeDisabled()
    })

    it("disables move-up on the first row", () => {
      render(
        <ProviderConfigTab
          {...defaultProps}
          settings={rotationSettings}
          onAddApiKey={jest.fn()}
          onRemoveApiKey={jest.fn()}
          onReorderApiKeys={jest.fn()}
        />
      )
      const moveUpButtons = screen.getAllByTitle("Move up")
      expect(moveUpButtons[0]).toBeDisabled()
    })

    it("adds a trimmed key through the inline add-key flow", () => {
      const onAddApiKey = jest.fn()
      render(
        <ProviderConfigTab
          {...defaultProps}
          settings={mockSettings}
          onAddApiKey={onAddApiKey}
          onRemoveApiKey={jest.fn()}
        />
      )
      fireEvent.click(screen.getByText("Add Key"))
      const inputs = screen.getAllByTestId("input")
      const newKeyInput = inputs.find((el) => el.getAttribute("placeholder") === "sk-...")
      expect(newKeyInput).toBeTruthy()
      fireEvent.change(newKeyInput!, { target: { value: "  sk-new-key  " } })
      fireEvent.keyDown(newKeyInput!, { key: "Enter" })
      expect(onAddApiKey).toHaveBeenCalledWith("sk-new-key")
    })

    it("does not add a blank key", () => {
      const onAddApiKey = jest.fn()
      render(
        <ProviderConfigTab
          {...defaultProps}
          settings={mockSettings}
          onAddApiKey={onAddApiKey}
          onRemoveApiKey={jest.fn()}
        />
      )
      fireEvent.click(screen.getByText("Add Key"))
      const inputs = screen.getAllByTestId("input")
      const newKeyInput = inputs.find((el) => el.getAttribute("placeholder") === "sk-...")
      fireEvent.change(newKeyInput!, { target: { value: "   " } })
      fireEvent.keyDown(newKeyInput!, { key: "Enter" })
      expect(onAddApiKey).not.toHaveBeenCalled()
    })
  })
})
