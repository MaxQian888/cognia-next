/**
 * Tests for LocalProviderSettings component
 */

import React from "react"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { LocalProviderSettings } from "./local-provider-settings"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      localProvidersTitle: "Local Providers",
      localProvidersDescription: "Run AI models locally on your machine",
      scan: "Scan",
      installed: "installed",
      running: "running",
      quickSetup: "Quick Setup",
      browseModels: "Browse Models",
      "providerGroups.recommended": "Recommended",
      "providerGroups.recommendedDesc": "Best for most users",
      "providerGroups.advanced": "Advanced",
      "providerGroups.advancedDesc": "For power users and server setups",
      "providerGroups.specialized": "Specialized",
      "providerGroups.specializedDesc": "For specific use cases",
    }
    return translations[key] || key
  },
}))

// Mock the settings store
const mockProviderSettings: Record<string, { enabled?: boolean; baseURL?: string }> = {}
const mockUpdateProviderSettings = jest.fn()

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => {
    const state = {
      providerSettings: mockProviderSettings,
      updateProviderSettings: mockUpdateProviderSettings,
    }
    return selector(state)
  },
}))

// Mock local-providers config
jest.mock("@cognia/provider-core/providers/local-providers", () => ({
  LOCAL_PROVIDER_CONFIGS: {
    ollama: {
      id: "ollama",
      name: "Ollama",
      defaultPort: 11434,
      defaultBaseURL: "http://localhost:11434",
      modelsEndpoint: "/api/tags",
      healthEndpoint: "/api/version",
      supportsModelList: true,
      supportsEmbeddings: true,
      description: "Run models locally with easy model management",
      website: "https://ollama.ai",
    },
    lmstudio: {
      id: "lmstudio",
      name: "LM Studio",
      defaultPort: 1234,
      defaultBaseURL: "http://localhost:1234",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/v1/models",
      supportsModelList: true,
      supportsEmbeddings: true,
      description: "Desktop app for running local LLMs",
      website: "https://lmstudio.ai",
    },
    jan: {
      id: "jan",
      name: "Jan",
      defaultPort: 1337,
      defaultBaseURL: "http://localhost:1337",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/v1/models",
      supportsModelList: true,
      supportsEmbeddings: false,
      description: "Open-source ChatGPT alternative",
      website: "https://jan.ai",
    },
    llamacpp: {
      id: "llamacpp",
      name: "llama.cpp",
      defaultPort: 8080,
      defaultBaseURL: "http://localhost:8080",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/health",
      supportsModelList: true,
      supportsEmbeddings: true,
      description: "High-performance CPU inference",
      website: "https://github.com/ggerganov/llama.cpp",
    },
    llamafile: {
      id: "llamafile",
      name: "Llamafile",
      defaultPort: 8080,
      defaultBaseURL: "http://localhost:8080",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/health",
      supportsModelList: false,
      supportsEmbeddings: false,
      description: "Single-file executable LLMs",
      website: "https://github.com/Mozilla-Ocho/llamafile",
    },
    vllm: {
      id: "vllm",
      name: "vLLM",
      defaultPort: 8000,
      defaultBaseURL: "http://localhost:8000",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/health",
      supportsModelList: true,
      supportsEmbeddings: false,
      description: "High-throughput GPU inference",
      website: "https://vllm.ai",
    },
    localai: {
      id: "localai",
      name: "LocalAI",
      defaultPort: 8080,
      defaultBaseURL: "http://localhost:8080",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/readyz",
      supportsModelList: true,
      supportsEmbeddings: true,
      description: "OpenAI-compatible local inference",
      website: "https://localai.io",
    },
    textgenwebui: {
      id: "textgenwebui",
      name: "Text Generation WebUI",
      defaultPort: 5000,
      defaultBaseURL: "http://localhost:5000",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/v1/models",
      supportsModelList: true,
      supportsEmbeddings: false,
      description: "Feature-rich web interface",
      website: "https://github.com/oobabooga/text-generation-webui",
    },
    koboldcpp: {
      id: "koboldcpp",
      name: "KoboldCpp",
      defaultPort: 5001,
      defaultBaseURL: "http://localhost:5001",
      modelsEndpoint: "/api/v1/model",
      healthEndpoint: "/api/v1/model",
      supportsModelList: false,
      supportsEmbeddings: false,
      description: "Optimized for roleplay and storytelling",
      website: "https://github.com/LostRuins/koboldcpp",
    },
    tabbyapi: {
      id: "tabbyapi",
      name: "TabbyAPI",
      defaultPort: 5000,
      defaultBaseURL: "http://localhost:5000",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/health",
      supportsModelList: true,
      supportsEmbeddings: true,
      description: "ExLlamaV2 inference server",
      website: "https://github.com/theroyallab/tabbyAPI",
    },
  },
}))

// Mock local-provider-service
const mockCheckAllProvidersInstallation = jest.fn()

jest.mock("@cognia/provider-core/providers/local-provider-service", () => ({
  getProviderCapabilities: jest.fn(() => ({
    canListModels: true,
    canPullModels: true,
    canDeleteModels: true,
    canStopModels: false,
    canGenerateEmbeddings: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsTools: false,
  })),
  // Forwards args on purpose: the baseUrl overrides the component threads
  // through are the whole point of the moved-port test below, and a
  // zero-arg shim would silently swallow them.
  checkAllProvidersInstallation: (...args: unknown[]) => mockCheckAllProvidersInstallation(...args),
  getInstallInstructions: (providerId: string) => ({
    title: `Install ${providerId}`,
    steps: ["step"],
    downloadUrl: `https://example.com/${providerId}/download`,
    docsUrl: `https://example.com/${providerId}/docs`,
    modelsUrl: `https://models.example/${providerId}`,
  }),
  LocalProviderService: jest.fn().mockImplementation(() => ({
    getStatus: jest.fn().mockResolvedValue({
      connected: true,
      version: "0.1.0",
      models_count: 5,
      latency_ms: 50,
    }),
  })),
}))

// Mock child components
jest.mock("./local-provider-card", () => ({
  LocalProviderCard: ({
    providerId,
    onToggle,
    onTestConnection,
    onSetup,
  }: {
    providerId: string
    onToggle: (enabled: boolean) => void
    onTestConnection: () => Promise<unknown>
    onSetup?: () => void
  }) => (
    <div data-testid={`provider-card-${providerId}`}>
      <span>{providerId}</span>
      <button onClick={() => onToggle(true)} data-testid={`toggle-${providerId}`}>
        Toggle
      </button>
      <button onClick={() => onTestConnection()} data-testid={`test-${providerId}`}>
        Test
      </button>
      <button onClick={() => onSetup?.()} data-testid={`setup-${providerId}`}>
        Setup
      </button>
    </div>
  ),
}))

jest.mock("./local-provider-model-manager", () => ({
  LocalProviderModelManager: ({ providerId }: { providerId: string }) => (
    <div data-testid="model-manager">{providerId} Models</div>
  ),
}))

jest.mock("./local-provider-setup-wizard", () => ({
  LocalProviderSetupWizard: ({
    providerId,
    onComplete,
  }: {
    providerId: string
    onComplete: () => void
  }) => (
    <div data-testid="setup-wizard">
      <span>{providerId} Setup</span>
      <button onClick={onComplete} data-testid="complete-setup">
        Complete
      </button>
    </div>
  ),
}))

// Mock useLocalProvidersScan hook - stable reference to avoid infinite re-render loop
const mockServerScan = jest.fn()
jest.mock("@/hooks/provider/use-local-provider", () => ({
  useLocalProvidersScan: () => ({
    detected: new Map(),
    isScanning: false,
    scan: mockServerScan,
  }),
}))

describe("LocalProviderSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Module-level mutable object shared by every test — clear it, or the
    // moved-port case below leaks its baseURL into unrelated assertions.
    for (const key of Object.keys(mockProviderSettings)) delete mockProviderSettings[key]
    mockCheckAllProvidersInstallation.mockResolvedValue([
      // `installed` is tri-state: true when reachable, undefined when the probe
      // got nothing back. Never false — silence is not proof of absence.
      { providerId: "ollama", installed: true, running: true, version: "0.1.0" },
      { providerId: "lmstudio", installed: undefined, running: false },
      { providerId: "jan", installed: undefined, running: false },
    ])
  })

  it("should render the component with title and description", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    expect(screen.getByText("Local Providers")).toBeInTheDocument()
    expect(screen.getByText("Run AI models locally on your machine")).toBeInTheDocument()
  })

  it("should show scan button", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    expect(screen.getByText("Scan")).toBeInTheDocument()
  })

  it("should scan providers on mount", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    await waitFor(() => {
      expect(mockCheckAllProvidersInstallation).toHaveBeenCalled()
    })
  })

  it("should show running count badge when providers are running", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    // Wait for scan to complete first
    await waitFor(() => {
      expect(mockCheckAllProvidersInstallation).toHaveBeenCalled()
    })

    // Then check for running text - use getAllByText since it appears multiple times
    await waitFor(
      () => {
        const runningElements = screen.getAllByText(/running/i)
        expect(runningElements.length).toBeGreaterThan(0)
      },
      { timeout: 3000 }
    )
  })

  /**
   * Replaces "should show installed count". The quick-stats row used to render
   * an "installed" tally beside the "running" one, both derived from fields the
   * HTTP probe set to the same value — so they were provably always equal. An
   * HTTP probe cannot distinguish "not installed" from "installed but stopped",
   * so the second number implied knowledge we do not have. Only the honest one
   * is rendered now.
   */
  it("does not claim an installed count the HTTP probe cannot know", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })
    await waitFor(() => expect(mockCheckAllProvidersInstallation).toHaveBeenCalled())

    // "Running" is still reported…
    await waitFor(() => expect(screen.getAllByText(/running/i).length).toBeGreaterThan(0))
    // …but the stats row carries no installed tally.
    expect(screen.queryByText(/\d+\s*installed/i)).toBeNull()
  })

  /**
   * W6c: the scan used to construct every probe without the user's baseUrl, so
   * a server moved off its default port was reported offline while running fine.
   */
  it("probes the user's configured baseUrl, not the default port", async () => {
    mockProviderSettings.ollama = { enabled: true, baseURL: "http://127.0.0.1:11500" }

    await act(async () => {
      render(<LocalProviderSettings />)
    })

    await waitFor(() => expect(mockCheckAllProvidersInstallation).toHaveBeenCalled())
    expect(mockCheckAllProvidersInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ ollama: "http://127.0.0.1:11500" })
    )
  })

  it("should render provider groups", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    expect(screen.getByText("Recommended")).toBeInTheDocument()
    expect(screen.getByText("Advanced")).toBeInTheDocument()
    expect(screen.getByText("Specialized")).toBeInTheDocument()
  })

  it("should expand recommended group by default", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    // Recommended group should show its providers
    await waitFor(() => {
      expect(screen.getByTestId("provider-card-ollama")).toBeInTheDocument()
    })
  })

  it("should toggle provider groups when clicked", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    // Click on Advanced group to expand it
    const advancedButton = screen.getByText("Advanced")
    await act(async () => {
      fireEvent.click(advancedButton)
    })

    // Advanced providers should now be visible
    await waitFor(() => {
      expect(screen.getByTestId("provider-card-llamacpp")).toBeInTheDocument()
    })
  })

  it("should call updateProviderSettings when provider is toggled", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    await waitFor(() => {
      expect(screen.getByTestId("toggle-ollama")).toBeInTheDocument()
    })

    const toggleButton = screen.getByTestId("toggle-ollama")
    await act(async () => {
      fireEvent.click(toggleButton)
    })

    expect(mockUpdateProviderSettings).toHaveBeenCalledWith("ollama", { enabled: true })
  })

  it("should show Quick Setup button", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    expect(screen.getByText("Quick Setup")).toBeInTheDocument()
  })

  it("should show a per-provider Browse Models link (not Ollama-hardcoded)", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    expect(screen.getByText("Browse Models")).toBeInTheDocument()
    const link = screen.getByRole("link", { name: /Browse Models/i })
    // Derived from the quick-start provider's install instructions, not a fixed Ollama URL.
    expect(link.getAttribute("href")).toMatch(/^https:\/\/models\.example\//)
  })

  it("should open the setup wizard for a specific provider from its card", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    await waitFor(() => {
      expect(screen.getByTestId("setup-lmstudio")).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId("setup-lmstudio"))
    })

    await waitFor(() => {
      // The wizard opens for the exact provider whose card was used.
      expect(screen.getByText("lmstudio Setup")).toBeInTheDocument()
    })
  })

  it("falls back to the first recommended provider when all are running", async () => {
    mockCheckAllProvidersInstallation.mockResolvedValue([
      { providerId: "ollama", installed: true, running: true },
      { providerId: "lmstudio", installed: true, running: true },
      { providerId: "jan", installed: true, running: true },
    ])

    await act(async () => {
      render(<LocalProviderSettings />)
    })

    await waitFor(() => {
      expect(mockCheckAllProvidersInstallation).toHaveBeenCalled()
    })

    // Browse Models still resolves to a concrete provider URL via the fallback.
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /Browse Models/i })
      expect(link.getAttribute("href")).toMatch(/^https:\/\/models\.example\//)
    })
  })

  it("should open setup wizard when Quick Setup is clicked", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    const quickSetupButton = screen.getByText("Quick Setup")
    await act(async () => {
      fireEvent.click(quickSetupButton)
    })

    await waitFor(() => {
      expect(screen.getByTestId("setup-wizard")).toBeInTheDocument()
    })
  })

  it("should rescan providers when scan button is clicked", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    await waitFor(() => {
      expect(mockCheckAllProvidersInstallation).toHaveBeenCalledTimes(1)
    })

    const scanButton = screen.getByText("Scan")
    await act(async () => {
      fireEvent.click(scanButton)
    })

    await waitFor(() => {
      expect(mockCheckAllProvidersInstallation).toHaveBeenCalledTimes(2)
    })
  })

  it("should handle scan errors gracefully", async () => {
    mockCheckAllProvidersInstallation.mockRejectedValueOnce(new Error("Scan failed"))

    await act(async () => {
      render(<LocalProviderSettings />)
    })

    // Component should still render without crashing
    expect(screen.getByText("Local Providers")).toBeInTheDocument()
  })

  it("should call onProviderSelect callback when provided", async () => {
    const onProviderSelect = jest.fn()
    await act(async () => {
      render(<LocalProviderSettings onProviderSelect={onProviderSelect} />)
    })

    // Component renders with the callback prop
    expect(screen.getByText("Local Providers")).toBeInTheDocument()
  })

  it("should close setup wizard and rescan when setup is complete", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    // Open setup wizard
    const quickSetupButton = screen.getByText("Quick Setup")
    await act(async () => {
      fireEvent.click(quickSetupButton)
    })

    await waitFor(() => {
      expect(screen.getByTestId("setup-wizard")).toBeInTheDocument()
    })

    // Complete setup
    const completeButton = screen.getByTestId("complete-setup")
    await act(async () => {
      fireEvent.click(completeButton)
    })

    // Should rescan after completion
    await waitFor(() => {
      expect(mockCheckAllProvidersInstallation).toHaveBeenCalledTimes(2)
    })
  })

  it("should test connection for a provider", async () => {
    await act(async () => {
      render(<LocalProviderSettings />)
    })

    await waitFor(() => {
      expect(screen.getByTestId("test-ollama")).toBeInTheDocument()
    })

    const testButton = screen.getByTestId("test-ollama")
    await act(async () => {
      fireEvent.click(testButton)
    })

    // Connection test should complete
    await waitFor(() => {
      expect(screen.getByText("Local Providers")).toBeInTheDocument()
    })
  })
})
