/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProviderSettings } from "./provider-settings"
import { probeProviderConnection } from "@/lib/ai/infrastructure/api-test"
import type { UserProviderSettings } from "@/types/provider"
import type { McpServerStatus as McpServerState } from "@/types/mcp"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock stores
const mockUpdateProviderSettings = jest.fn()
const mockUpdateCustomProvider = jest.fn()
const mockAddApiKey = jest.fn()
const mockRemoveApiKey = jest.fn()
const mockReorderApiKeys = jest.fn()
const mockSetApiKeyRotation = jest.fn()
const mockResetApiKeyStats = jest.fn()
const mockSetProviderViewMode = jest.fn()
const mockSetProviderSortBy = jest.fn()
const mockSetProviderSortOrder = jest.fn()
const mockSetProviderCategoryFilter = jest.fn()
const mockSetSelectedProviderId = jest.fn()
const mockInitializeMcp = jest.fn().mockResolvedValue(undefined)
const mockAddMcpServer = jest.fn().mockResolvedValue(undefined)
const mockConnectMcpServer = jest.fn().mockResolvedValue(undefined)

const mockProviderSettings: Record<string, Partial<UserProviderSettings>> = {
  openai: { apiKey: "test-key", enabled: true },
  anthropic: { apiKey: "", enabled: false },
  google: { apiKey: "", enabled: false },
  zhipu: { apiKey: "", enabled: false, defaultModel: "glm-4-flash" },
  minimax: { apiKey: "", enabled: false, defaultModel: "MiniMax-M2.7" },
  ollama: { enabled: true, baseURL: "http://localhost:11434" },
}

const mockSettingsState = {
  providerSettings: mockProviderSettings,
  language: "en",
  customProviders: {},
  updateProviderSettings: mockUpdateProviderSettings,
  updateCustomProvider: mockUpdateCustomProvider,
  addApiKey: mockAddApiKey,
  removeApiKey: mockRemoveApiKey,
  reorderApiKeys: mockReorderApiKeys,
  setApiKeyRotation: mockSetApiKeyRotation,
  resetApiKeyStats: mockResetApiKeyStats,
  providerUIPreferences: {
    viewMode: "cards",
    sortBy: "name",
    sortOrder: "asc",
    categoryFilter: "all",
    selectedProviderId: null,
  },
  setProviderViewMode: mockSetProviderViewMode,
  setSelectedProviderId: mockSetSelectedProviderId,
  setProviderSortBy: mockSetProviderSortBy,
  setProviderSortOrder: mockSetProviderSortOrder,
  setProviderCategoryFilter: mockSetProviderCategoryFilter,
}

jest.mock("@/stores", () => ({
  useSettingsStore: jest.fn((selector: (state: typeof mockSettingsState) => unknown) =>
    selector(mockSettingsState)
  ),
}))

const mockMcpState = {
  servers: [] as McpServerState[],
  isInitialized: true,
  initialize: mockInitializeMcp,
  addServer: mockAddMcpServer,
  connectServer: mockConnectMcpServer,
}

jest.mock("@/stores/mcp", () => ({
  useMcpStore: jest.fn((selector: (state: typeof mockMcpState) => unknown) =>
    selector(mockMcpState)
  ),
}))

// Mock provider types
jest.mock("@/types/provider", () => ({
  PROVIDERS: {
    openai: {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-4", name: "GPT-4" }],
      defaultModel: "gpt-4",
      category: "flagship",
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: [{ id: "claude-3", name: "Claude 3" }],
      defaultModel: "claude-3",
      category: "flagship",
    },
    zhipu: {
      id: "zhipu",
      name: "Zhipu AI (智谱清言)",
      models: [{ id: "glm-4-flash", name: "GLM-4 Flash" }],
      defaultModel: "glm-4-flash",
      category: "specialized",
    },
    minimax: {
      id: "minimax",
      name: "MiniMax",
      models: [{ id: "MiniMax-M2.7", name: "MiniMax M2.7" }],
      defaultModel: "MiniMax-M2.7",
      category: "specialized",
    },
    ollama: {
      id: "ollama",
      name: "Ollama",
      models: [{ id: "llama3", name: "Llama 3" }],
      defaultModel: "llama3",
      category: "local",
    },
  },
  getProviderConfig: (providerId: string) => {
    const providers = {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: [{ id: "gpt-4", name: "GPT-4" }],
        defaultModel: "gpt-4",
        category: "flagship",
      },
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        models: [{ id: "claude-3", name: "Claude 3" }],
        defaultModel: "claude-3",
        category: "flagship",
      },
      zhipu: {
        id: "zhipu",
        name: "Zhipu AI (智谱清言)",
        models: [{ id: "glm-4-flash", name: "GLM-4 Flash" }],
        defaultModel: "glm-4-flash",
        category: "specialized",
      },
      minimax: {
        id: "minimax",
        name: "MiniMax",
        models: [{ id: "MiniMax-M2.7", name: "MiniMax M2.7" }],
        defaultModel: "MiniMax-M2.7",
        category: "specialized",
      },
      ollama: {
        id: "ollama",
        name: "Ollama",
        models: [{ id: "llama3", name: "Llama 3" }],
        defaultModel: "llama3",
        category: "local",
      },
    } as const

    return providers[providerId as keyof typeof providers]
  },
  getAllProviders: () => ({
    openai: {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-4", name: "GPT-4" }],
      defaultModel: "gpt-4",
      category: "flagship",
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: [{ id: "claude-3", name: "Claude 3" }],
      defaultModel: "claude-3",
      category: "flagship",
    },
    zhipu: {
      id: "zhipu",
      name: "Zhipu AI (智谱清言)",
      models: [{ id: "glm-4-flash", name: "GLM-4 Flash" }],
      defaultModel: "glm-4-flash",
      category: "specialized",
    },
    minimax: {
      id: "minimax",
      name: "MiniMax",
      models: [{ id: "MiniMax-M2.7", name: "MiniMax M2.7" }],
      defaultModel: "MiniMax-M2.7",
      category: "specialized",
    },
    ollama: {
      id: "ollama",
      name: "Ollama",
      models: [{ id: "llama3", name: "Llama 3" }],
      defaultModel: "llama3",
      category: "local",
    },
  }),
}))

// Mock API test
jest.mock("@/lib/ai/infrastructure/api-test", () => ({
  testProviderConnection: jest.fn().mockResolvedValue({ success: true, latency_ms: 100 }),
  probeProviderConnection: jest.fn().mockResolvedValue({
    success: true,
    authoritative: true,
    outcome: "verified",
    message: "Connected successfully.",
    latency_ms: 100,
  }),
  testCustomProviderConnectionByProtocol: jest.fn().mockResolvedValue({
    success: true,
    message: "Connected successfully.",
    latency_ms: 100,
  }),
}))

jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
  },
}))

// Mock API key rotation
jest.mock("@/lib/ai/infrastructure/api-key-rotation", () => ({
  maskApiKey: (key: string) => (key ? `${key.slice(0, 4)}...${key.slice(-4)}` : ""),
  isValidApiKeyFormat: () => true,
}))

// Mock child components
jest.mock("./custom-provider-dialog", () => ({
  CustomProviderDialog: () => <div data-testid="custom-provider-dialog" />,
}))

jest.mock("./oauth-login-button", () => ({
  OAuthLoginButton: () => null,
}))

jest.mock("./provider-import-export", () => ({
  ProviderImportExport: () => <div data-testid="provider-import-export" />,
}))

jest.mock("./provider-health-status", () => ({
  ProviderHealthStatus: () => <div data-testid="provider-health-status" />,
}))

jest.mock("./ollama-model-manager", () => ({
  OllamaModelManager: () => <div data-testid="ollama-model-manager" />,
}))

jest.mock("./local-provider-settings", () => ({
  LocalProviderSettings: () => <div data-testid="local-provider-settings" />,
}))

jest.mock("@/hooks/settings/use-model-discovery", () => ({
  useModelDiscovery: () => ({
    isFetching: false,
    lastFetched: undefined,
    fetchModels: jest.fn(),
    error: undefined,
    supportsDiscovery: false,
  }),
}))

jest.mock("@/lib/ai/providers/projection", () => ({
  buildProviderStateProjectionMap: () => ({}),
}))

// Mock UI components
jest.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}))

jest.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    placeholder,
    id,
    disabled,
    type,
  }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      id={id}
      disabled={disabled}
      type={type}
      data-testid={id || "input"}
    />
  ),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props} data-variant={variant}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
    disabled?: boolean
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onCheckedChange?.(!checked)}
      disabled={disabled}
      data-testid="switch"
    >
      Switch
    </button>
  ),
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
}))

jest.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value: number }) => <div data-testid="progress" data-value={value} />,
}))

jest.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertTitle: ({ children }: { children: React.ReactNode }) => <h4>{children}</h4>,
}))

jest.mock("@/components/ui/tabs", () => {
  const React = jest.requireActual<typeof import("react")>("react")

  const TabsContext = React.createContext({
    value: undefined as string | undefined,
    onValueChange: undefined as ((v: string) => void) | undefined,
  })

  return {
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode
      value?: string
      onValueChange?: (v: string) => void
    }) => (
      <TabsContext.Provider value={{ value, onValueChange }}>
        <div data-testid="tabs">{children}</div>
      </TabsContext.Provider>
    ),
    TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
    TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const ctx = React.useContext(TabsContext)
      const selected = ctx.value === value
      return (
        <button role="tab" aria-selected={selected} onClick={() => ctx.onValueChange?.(value)}>
          {children}
        </button>
      )
    },
    TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }
})

jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <div data-testid="select" data-value={value}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  SelectValue: () => <span>Value</span>,
}))

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/lib/utils", () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
}))

describe("ProviderSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSettingsState.providerSettings = {
      openai: { apiKey: "test-key", enabled: true },
      anthropic: { apiKey: "", enabled: false },
      google: { apiKey: "", enabled: false },
      zhipu: { apiKey: "", enabled: false, defaultModel: "glm-4-flash" },
      minimax: { apiKey: "", enabled: false, defaultModel: "MiniMax-M2.7" },
      ollama: { enabled: true, baseURL: "http://localhost:11434" },
    }
    mockSettingsState.customProviders = {}
    mockSettingsState.providerUIPreferences = {
      viewMode: "cards",
      sortBy: "name",
      sortOrder: "asc",
      categoryFilter: "all",
      selectedProviderId: null,
    }
    mockMcpState.servers = []
    mockMcpState.isInitialized = true
  })

  it("renders provider settings component", () => {
    render(<ProviderSettings />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("renders provider header with search", () => {
    render(<ProviderSettings />)
    // The header should render with a search input
    expect(screen.getByPlaceholderText("searchProviders")).toBeInTheDocument()
  })

  it("displays OpenAI provider", () => {
    render(<ProviderSettings />)
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("displays Anthropic provider", () => {
    render(<ProviderSettings />)
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
  })

  it("offers built-in migration action when an equivalent custom provider exists", () => {
    mockSettingsState.customProviders = {
      "custom-zhipu": {
        providerId: "custom-zhipu",
        customName: "Zhipu API",
        baseURL: "https://open.bigmodel.cn/api/paas/v4",
        apiKey: "zhipu-key",
        apiProtocol: "openai",
        customModels: ["glm-4.6", "glm-4-flash"],
        defaultModel: "glm-4.6",
        enabled: true,
      },
    }

    render(<ProviderSettings />)

    expect(screen.getAllByText("importEquivalentCustomProvider").length).toBeGreaterThan(0)
  })

  it("imports equivalent custom providers with discovery cache intact", () => {
    mockSettingsState.customProviders = {
      "custom-zhipu": {
        providerId: "custom-zhipu",
        customName: "Zhipu Mirror",
        baseURL: "https://open.bigmodel.cn/api/paas/v4",
        apiKey: "zhipu-key",
        apiProtocol: "openai",
        discoveredModels: [{ id: "glm-4-flash", name: "GLM-4 Flash" }],
        discoveredModelsLastFetched: 1_700_000_000_000,
        enabled: true,
      },
    }

    render(<ProviderSettings />)

    fireEvent.click(screen.getAllByRole("button", { name: "importEquivalentCustomProvider" })[0])

    expect(mockUpdateProviderSettings).toHaveBeenCalledWith(
      "zhipu",
      expect.objectContaining({
        apiKey: "zhipu-key",
        discoveredModels: [{ id: "glm-4-flash", name: "GLM-4 Flash" }],
        discoveredModelsLastFetched: 1_700_000_000_000,
      })
    )
  })

  it("shows local providers section when local tab is selected", async () => {
    mockSettingsState.providerUIPreferences.categoryFilter = "local"
    render(<ProviderSettings />)
    expect(await screen.findByTestId("local-provider-settings")).toBeInTheDocument()
  })

  it("displays quick add button", () => {
    render(<ProviderSettings />)
    expect(screen.getByText("quickAdd")).toBeInTheDocument()
  })

  it("displays custom providers in unified list", () => {
    mockSettingsState.customProviders = {
      custom1: {
        isCustom: true,
        customName: "My Custom",
        baseURL: "https://api.example.com",
        apiKey: "key",
        enabled: true,
        customModels: ["model-1"],
        apiProtocol: "openai",
      },
    }
    render(<ProviderSettings />)
    expect(screen.getByText("My Custom")).toBeInTheDocument()
  })

  it("displays add provider button", () => {
    render(<ProviderSettings />)
    expect(screen.getByText("addCustomShort")).toBeInTheDocument()
  })

  it("renders add custom provider button", () => {
    render(<ProviderSettings />)
    expect(screen.getByText("addCustomShort")).toBeInTheDocument()
  })

  it("renders custom provider dialog", () => {
    render(<ProviderSettings />)
    expect(screen.getByTestId("custom-provider-dialog")).toBeInTheDocument()
  })

  it("displays configured providers count", () => {
    render(<ProviderSettings />)
    expect(screen.getByText(/provider.*configured/i)).toBeInTheDocument()
  })

  it("renders switches for providers", () => {
    render(<ProviderSettings />)
    const switches = screen.getAllByRole("switch")
    expect(switches.length).toBeGreaterThan(0)
  })

  it("toggles provider enabled state", () => {
    render(<ProviderSettings />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[0])
    expect(mockUpdateProviderSettings).toHaveBeenCalled()
  })

  it("blocks enabling providers that have no credential configured", () => {
    render(<ProviderSettings />)
    const switches = screen.getAllByRole("switch")
    const blockedSwitch = switches.find((node) => node.hasAttribute("disabled"))
    expect(blockedSwitch).toBeDefined()
    fireEvent.click(blockedSwitch!)
    expect(mockUpdateProviderSettings).not.toHaveBeenCalledWith("anthropic", { enabled: true })
  })

  it("renders provider list items with switches", () => {
    render(<ProviderSettings />)
    const switches = screen.getAllByRole("switch")
    expect(switches.length).toBeGreaterThan(0)
  })

  it("uses the active pooled API key when testing built-in providers", async () => {
    mockSettingsState.providerSettings.openai = {
      apiKey: "",
      apiKeys: ["sk-primary", "sk-pooled-active"],
      currentKeyIndex: 1,
      enabled: true,
      defaultModel: "gpt-4",
    }

    render(<ProviderSettings />)
    fireEvent.click(screen.getAllByRole("button", { name: "test" })[0])

    await waitFor(() => {
      expect(probeProviderConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "openai",
          apiKey: "sk-pooled-active",
        })
      )
    })
  })

  it("does not present runtime-limited verification as connected success", async () => {
    ;(probeProviderConnection as jest.Mock).mockResolvedValueOnce({
      success: false,
      authoritative: false,
      outcome: "limited",
      message: "Authoritative verification requires the desktop app.",
      latency_ms: 0,
    })

    render(<ProviderSettings />)

    // Click on OpenAI to expand, then test
    fireEvent.click(screen.getByText("OpenAI"))
    const testButtons = screen.getAllByRole("button", { name: "test" })
    fireEvent.click(testButtons[0])

    await waitFor(() => {
      expect(probeProviderConnection).toHaveBeenCalled()
    })

    expect(screen.queryByText("connected")).not.toBeInTheDocument()
  })

  it("returns equivalent blocked test guidance across card and table views", () => {
    mockSettingsState.providerSettings.openai = { apiKey: "", enabled: true }

    const { rerender } = render(<ProviderSettings />)
    const cardTestButtonWithReason = screen
      .getAllByRole("button", { name: "test" })
      .find((button) => button.getAttribute("title"))
    const blockedReason = cardTestButtonWithReason?.getAttribute("title")
    expect(blockedReason).toBeTruthy()

    mockSettingsState.providerUIPreferences.viewMode = "table"
    rerender(<ProviderSettings />)
    expect(screen.getAllByTitle(blockedReason as string).length).toBeGreaterThan(0)
  })

  it("renders onboarding banner when no providers are configured", () => {
    mockSettingsState.providerSettings = {
      openai: { apiKey: "", enabled: false },
      anthropic: { apiKey: "", enabled: false },
      google: { apiKey: "", enabled: false },
      minimax: { apiKey: "", enabled: false, defaultModel: "MiniMax-M2.7" },
      ollama: { enabled: false, baseURL: "http://localhost:11434" },
    }
    mockSettingsState.customProviders = {}
    mockSettingsState.providerUIPreferences.categoryFilter = "all"

    render(<ProviderSettings />)
    // Onboarding banner shows instead of empty state
    expect(screen.getByText("onboardingTitle")).toBeInTheDocument()
    // Provider list is always visible - OpenAI should be shown
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("adds and connects coding-package MCP presets from provider settings when package gating passes", async () => {
    mockSettingsState.providerSettings.minimax = {
      apiKey: "minimax-key",
      enabled: true,
      defaultModel: "MiniMax-M2.7",
    }

    render(<ProviderSettings />)
    fireEvent.click(screen.getByText("MiniMax"))

    fireEvent.click(await screen.findByTestId("coding-package-mcp-action-minimax-coding-plan"))

    await waitFor(() => {
      expect(mockAddMcpServer).toHaveBeenCalledWith(
        "minimax-coding-plan",
        expect.objectContaining({
          connectionType: "stdio",
          env: expect.objectContaining({
            MINIMAX_API_KEY: "minimax-key",
          }),
        })
      )
    })
    expect(mockConnectMcpServer).toHaveBeenCalledWith("minimax-coding-plan")
  })

  it("reuses existing MCP servers by connecting them instead of re-adding presets", async () => {
    mockSettingsState.providerSettings.zhipu = {
      apiKey: "zhipu-key",
      enabled: true,
      defaultModel: "glm-4.6",
    }
    // The MCP server fixture below is shaped per Cognia's `McpServerStatus`,
    // which has a richer discriminated union in cognia-next. Cast to bypass
    // the structural mismatch — this test exercises a deferred code path
    // (provider coding-package MCP integration) and will be revisited once
    // that feature lands.
    mockMcpState.servers = [
      {
        id: "glm-search",
        name: "GLM Search MCP",
        config: {
          name: "GLM Search MCP",
          command: "",
          args: [],
          env: {},
          connectionType: "streamableHttp",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          enabled: true,
          autoStart: false,
          fallbackToSse: true,
          experimentalFeatures: {},
        },
        status: { type: "disconnected" },
        tools: [],
        resources: [],
        prompts: [],
        roots: [],
        reconnectAttempts: 0,
        connectionVersion: 0,
        experimentalCapabilities: [],
        notificationFeed: [],
        pendingInteractions: [],
      } as unknown as McpServerState,
    ]

    render(<ProviderSettings />)
    fireEvent.click(screen.getByText("Zhipu AI (智谱清言)"))

    fireEvent.click(await screen.findByTestId("coding-package-mcp-action-glm-search"))

    await waitFor(() => {
      expect(mockConnectMcpServer).toHaveBeenCalledWith("glm-search")
    })
    expect(mockAddMcpServer).not.toHaveBeenCalled()
  })

  it("distinguishes MiniMax local MCP from GLM local and remote options and blocks non-package models", async () => {
    mockSettingsState.providerSettings.minimax = {
      apiKey: "minimax-key",
      enabled: true,
      defaultModel: "MiniMax-M2.7",
    }
    mockSettingsState.providerSettings.zhipu = {
      apiKey: "zhipu-key",
      enabled: true,
      defaultModel: "glm-4-flash",
    }

    render(<ProviderSettings />)
    fireEvent.click(screen.getByText("MiniMax"))
    fireEvent.click(screen.getByText("Zhipu AI (智谱清言)"))

    expect(await screen.findByText("codingPackageMcpMinimaxHint")).toBeInTheDocument()
    expect(await screen.findByText("codingPackageMcpZhipuHint")).toBeInTheDocument()
    expect(screen.getByTestId("coding-package-mcp-action-glm-search")).toBeDisabled()
  })

  it("recomputes readiness after provider config changes invalidate previous verification", async () => {
    mockSettingsState.providerSettings.openai = {
      ...mockSettingsState.providerSettings.openai,
      verificationStatus: "verified",
      verificationFingerprint: JSON.stringify({
        apiKey: "test-key",
        apiKeys: [],
        currentKeyIndex: 0,
        baseURL: "",
        defaultModel: "",
      }),
    }
    const { rerender } = render(<ProviderSettings />)

    // Expand OpenAI and click test
    fireEvent.click(screen.getByText("OpenAI"))
    const testButtons = screen.getAllByRole("button", { name: "test" })
    fireEvent.click(testButtons[0])

    await waitFor(() => {
      expect(probeProviderConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "openai",
          apiKey: "test-key",
        })
      )
    })

    mockSettingsState.providerSettings = {
      ...mockSettingsState.providerSettings,
      openai: {
        ...mockSettingsState.providerSettings.openai,
        apiKey: "updated-key",
      },
    }
    rerender(<ProviderSettings />)

    // After config change, verification should be invalidated
    await waitFor(() => {
      expect(mockUpdateProviderSettings).toHaveBeenCalledWith(
        "openai",
        expect.objectContaining({
          verificationStatus: "stale",
        })
      )
    })
  })
})
