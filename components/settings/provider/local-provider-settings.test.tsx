/**
 * Tests for LocalProviderSettings component
 */

import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { LocalProviderSettings } from "./local-provider-settings"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) => {
    if (key === "connectedSummary") {
      const version = values?.version === "none" ? "" : ` v${values?.version}`
      const count = typeof values?.count === "number" ? ` (${values.count} models)` : ""
      return `Connected${version}${count}`
    }
    const translations: Record<string, string> = {
      apiKey: "API Key",
      apiKeyPlaceholder: "Enter API key",
      localProviderApiKeyHint: "Optional local auth",
      setupGuide: "Setup guide",
      browseModels: "Browse Models",
      providerDocumentation: "Provider documentation",
      followStepsToStart: "Follow these steps to get started",
      providerSetup: values?.provider ? `${values.provider} setup` : "Provider setup",
      providerModels: values?.provider ? `${values.provider} Models` : "Provider Models",
      manageInstalledModels: values?.provider
        ? `Manage installed models for ${values.provider}`
        : "Manage installed models",
      connectionFailed: "Connection failed",
    }
    return translations[key] || key
  },
}))

const mockState = {
  providerSettings: {
    ollama: {
      enabled: true,
      baseURL: "http://127.0.0.1:11500",
      apiKey: "secret",
      customHeaders: { "x-test": "1" },
      defaultModel: "old-model",
    },
  } as Record<string, Record<string, unknown>>,
  setProviderConfig: jest.fn().mockResolvedValue(undefined),
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}))

let mockHostProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => mockHostProfile,
}))

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
      description: "Run models locally",
      website: "https://ollama.ai",
    },
  },
}))

const getStatus = jest.fn()
const listModels = jest.fn()
const createLocalProviderService = jest.fn(
  (_providerId: string, _options: Record<string, unknown>) => ({ getStatus, listModels })
)
const getProviderCapabilities = jest.fn(() => ({
  canListModels: true,
  canPullModels: true,
  canDeleteModels: true,
  canStopModels: true,
  canGenerateEmbeddings: true,
  supportsStreaming: true,
  supportsVision: true,
  supportsTools: true,
}))

jest.mock("@cognia/provider-core/providers/local-provider-service", () => ({
  createLocalProviderService: (...args: unknown[]) =>
    createLocalProviderService(...(args as [string, Record<string, unknown>])),
  getProviderCapabilities: (...args: unknown[]) => getProviderCapabilities(...(args as [])),
  getInstallInstructions: jest.fn(() => ({
    title: "Install Ollama",
    steps: ["Download", "Install"],
    downloadUrl: "https://ollama.ai/download",
    docsUrl: "https://ollama.ai/docs",
    modelsUrl: "https://ollama.ai/library",
  })),
}))

jest.mock("./local-provider-card", () => ({
  LocalProviderCard: ({
    providerId,
    onTestConnection,
    onManageModels,
    onSetup,
    onBaseUrlChange,
  }: {
    providerId: string
    onTestConnection: () => Promise<unknown>
    onManageModels?: () => void
    onSetup?: () => void
    onBaseUrlChange: (value: string) => void
  }) => (
    <div data-testid="local-provider-card">
      <span>{providerId}</span>
      <button onClick={() => void onTestConnection()} data-testid="test-connection">
        Test
      </button>
      <button onClick={() => onManageModels?.()} data-testid="manage-models">
        Manage
      </button>
      <button onClick={() => onSetup?.()} data-testid="setup-guide">
        Setup
      </button>
      <button
        onClick={() => onBaseUrlChange("http://127.0.0.1:22444")}
        data-testid="change-base-url"
      >
        Change URL
      </button>
    </div>
  ),
}))

jest.mock("./local-provider-model-manager", () => ({
  LocalProviderModelManager: ({
    providerId,
    baseUrl,
    apiKey,
    customHeaders,
    onModelsChange,
  }: {
    providerId: string
    baseUrl?: string
    apiKey?: string
    customHeaders?: Record<string, string>
    onModelsChange?: (models: Array<{ id: string }>) => void
  }) => {
    React.useEffect(() => {
      onModelsChange?.([{ id: "manager-model" }])
    }, [onModelsChange])
    return (
      <div data-testid="model-manager">
        {providerId}|{baseUrl}|{apiKey}|{customHeaders?.["x-test"]}
      </div>
    )
  },
}))

jest.mock("./local-provider-setup-wizard", () => ({
  LocalProviderSetupWizard: ({
    providerId,
    baseUrl,
    apiKey,
    customHeaders,
  }: {
    providerId: string
    baseUrl?: string
    apiKey?: string
    customHeaders?: Record<string, string>
  }) => (
    <div data-testid="setup-wizard">
      {providerId}|{baseUrl}|{apiKey}|{customHeaders?.["x-test"]}
    </div>
  ),
}))

jest.mock("./transport-headers-editor", () => ({
  TransportHeadersEditor: () => <div data-testid="headers-editor" />,
}))

describe("LocalProviderSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getStatus.mockResolvedValue({
      connected: true,
      version: "0.6.0",
      models_count: 2,
      latency_ms: 42,
    })
    listModels.mockResolvedValue([
      { id: "llama3.2", owned_by: "ollama", context_length: 8192 },
      { id: "qwen2.5", owned_by: "ollama" },
    ])
  })

  it("loads the selected provider status on mount using the configured endpoint and auth", async () => {
    render(<LocalProviderSettings providerId="ollama" />)

    await waitFor(() => expect(createLocalProviderService).toHaveBeenCalled())
    expect(createLocalProviderService).toHaveBeenCalledWith("ollama", {
      baseUrl: "http://127.0.0.1:11500",
      apiKey: "secret",
      customHeaders: { "x-test": "1" },
    })
  })

  it("persists discovered local models and verification state after a successful test", async () => {
    render(<LocalProviderSettings providerId="ollama" />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("test-connection"))
    })

    await waitFor(() => {
      expect(mockState.setProviderConfig).toHaveBeenCalledWith(
        "ollama",
        expect.objectContaining({
          discoveredModels: [
            {
              id: "llama3.2",
              name: "llama3.2",
              provider: "ollama",
              contextLength: 8192,
            },
            {
              id: "qwen2.5",
              name: "qwen2.5",
              provider: "ollama",
              contextLength: undefined,
            },
          ],
          discoveredModelsLastFetched: expect.any(Number),
          defaultModel: "llama3.2",
        })
      )
      expect(mockState.setProviderConfig).toHaveBeenCalledWith(
        "ollama",
        expect.objectContaining({
          verificationStatus: "verified",
          healthStatus: "healthy",
          verificationMessage: "Connected v0.6.0 (2 models)",
        })
      )
    })
  })

  it("marks the provider unverified when model discovery fails after the server responds", async () => {
    listModels.mockRejectedValueOnce(new Error("Model listing failed"))
    render(<LocalProviderSettings providerId="ollama" />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("test-connection"))
    })

    await waitFor(() => {
      expect(mockState.setProviderConfig).toHaveBeenCalledWith(
        "ollama",
        expect.objectContaining({
          verificationStatus: "unverified",
          healthStatus: "error",
          verificationMessage: "Model listing failed",
        })
      )
    })
  })

  it("passes the configured connection settings through to the setup wizard", async () => {
    render(<LocalProviderSettings providerId="ollama" />)

    fireEvent.click(screen.getByTestId("setup-guide"))

    expect(await screen.findByTestId("setup-wizard")).toHaveTextContent(
      "ollama|http://127.0.0.1:11500|secret|1"
    )
  })

  it("persists base URL edits from the provider card", async () => {
    render(<LocalProviderSettings providerId="ollama" />)

    fireEvent.click(screen.getByTestId("change-base-url"))

    await waitFor(() => {
      expect(mockState.setProviderConfig).toHaveBeenCalledWith("ollama", {
        baseURL: "http://127.0.0.1:22444",
      })
    })
  })

  it("renders the transport headers editor for local custom headers", () => {
    render(<LocalProviderSettings providerId="ollama" />)
    expect(screen.getByTestId("headers-editor")).toBeInTheDocument()
  })

  it("draft-buffers the API key: keystrokes stay local, blur commits, and no probe fires per key", async () => {
    render(<LocalProviderSettings providerId="ollama" />)
    await waitFor(() => expect(createLocalProviderService).toHaveBeenCalled())
    const probesBeforeTyping = createLocalProviderService.mock.calls.length
    const input = screen.getByTestId("local-provider-api-key-input")
    fireEvent.change(input, { target: { value: "s" } })
    fireEvent.change(input, { target: { value: "se" } })
    fireEvent.change(input, { target: { value: "sec" } })
    expect(mockState.setProviderConfig).not.toHaveBeenCalledWith(
      "ollama",
      expect.objectContaining({ apiKey: expect.any(String) })
    )
    fireEvent.blur(input)
    expect(mockState.setProviderConfig).toHaveBeenCalledWith("ollama", { apiKey: "sec" })
    // The store mock is inert (no re-render with a new key), so the probe count
    // must not have moved on the keystrokes themselves.
    expect(createLocalProviderService.mock.calls.length).toBe(probesBeforeTyping)
  })

  it("does not auto-probe the default localhost endpoint on the mobile shell", async () => {
    mockHostProfile = "mobile-companion"
    const savedBaseURL = mockState.providerSettings.ollama.baseURL
    // A stored custom base URL still probes (it may point at a LAN machine).
    try {
      render(<LocalProviderSettings providerId="ollama" />)
      await waitFor(() => expect(createLocalProviderService).toHaveBeenCalled())
      expect(screen.getByTestId("provider-host-notice-mobile-local")).toBeInTheDocument()
    } finally {
      mockHostProfile = "desktop"
      mockState.providerSettings.ollama.baseURL = savedBaseURL
    }
  })

  it("skips the auto-probe entirely on the mobile shell without a custom base URL", async () => {
    mockHostProfile = "mobile-companion"
    const savedBaseURL = mockState.providerSettings.ollama.baseURL
    mockState.providerSettings.ollama.baseURL = undefined
    try {
      render(<LocalProviderSettings providerId="ollama" />)
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(createLocalProviderService).not.toHaveBeenCalled()
    } finally {
      mockHostProfile = "desktop"
      mockState.providerSettings.ollama.baseURL = savedBaseURL
    }
  })
})
