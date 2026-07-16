/**
 * Tests for LocalProviderModelManager component
 */

import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { LocalProviderModelManager } from "./local-provider-model-manager"

// Mock next-intl with direct translations
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      connected: "Connected",
      disconnected: "Not connected",
    }
    return translations[key] || key
  },
}))

const renderWithProviders = (ui: React.ReactElement) => {
  return render(ui)
}

// Mock useLocalProvider hook
const mockRefresh = jest.fn()
const mockPullModel = jest.fn()
const mockCancelPull = jest.fn()
const mockDeleteModel = jest.fn().mockResolvedValue(true)
const mockStopModel = jest.fn().mockResolvedValue(true)

jest.mock("@/hooks/provider/use-local-provider", () => ({
  useLocalProvider: jest.fn(() => ({
    providerId: "ollama",
    config: {
      id: "ollama",
      name: "Ollama",
      defaultPort: 11434,
      defaultBaseURL: "http://localhost:11434",
      description: "Run models locally",
      website: "https://ollama.ai",
    },
    capabilities: {
      canListModels: true,
      canPullModels: true,
      canDeleteModels: true,
      canStopModels: true,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
    },
    status: {
      connected: true,
      version: "0.1.0",
      models_count: 2,
    },
    isConnected: true,
    isLoading: false,
    error: null,
    models: [
      { id: "llama3.2", object: "model", size: 2000000000 },
      { id: "qwen2.5", object: "model", size: 4000000000 },
    ],
    pullStates: new Map(),
    isPulling: false,
    refresh: mockRefresh,
    pullModel: mockPullModel,
    cancelPull: mockCancelPull,
    deleteModel: mockDeleteModel,
    stopModel: mockStopModel,
  })),
}))

// Capability probing hits /api/show over the network. Mock it, or the real hook
// runs, reaches an absent jsdom `fetch`, and silently lands on the name-guess
// fallback — a green test proving nothing about what the component renders.
const mockCapabilities = new Map<string, unknown>()
jest.mock("@/hooks/provider/use-ollama-model-capabilities", () => ({
  useOllamaModelCapabilities: jest.fn(() => ({
    capabilities: mockCapabilities,
    isProbing: false,
  })),
}))

// Mock local-provider-service
jest.mock("@cognia/provider-core/providers/local-provider-service", () => ({
  getInstallInstructions: jest.fn(() => ({
    title: "Install Ollama",
    steps: ["Download", "Install", "Run"],
    downloadUrl: "https://ollama.ai/download",
    docsUrl: "https://ollama.ai/docs",
  })),
}))

// Mock local-provider types
jest.mock("@cognia/provider-types/local-provider", () => ({
  formatLocalModelSize: jest.fn((bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }),
}))

describe("LocalProviderModelManager", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render provider name and status", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(
      screen.getByText((content) => content === "providerModels" || content === "Ollama Models")
    ).toBeInTheDocument()
    // Status indicator is present (i18n text may vary in test environment)
    const statusIndicator = document.querySelector(".bg-green-500")
    expect(statusIndicator).toBeInTheDocument()
  })

  it("should show version when connected", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText(/v0.1.0/)).toBeInTheDocument()
  })

  it("should show model count badge", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText("2 models")).toBeInTheDocument()
  })

  it("should render installed models list", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText("llama3.2")).toBeInTheDocument()
    expect(screen.getByText("qwen2.5")).toBeInTheDocument()
  })

  it("should show pull input field", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByPlaceholderText(/Pull a model/)).toBeInTheDocument()
  })

  it("should call pullModel when form is submitted", async () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    const input = screen.getByPlaceholderText(/Pull a model/)
    fireEvent.change(input, { target: { value: "mistral" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => {
      expect(mockPullModel).toHaveBeenCalledWith("mistral")
    })
  })

  it("should call refresh when refresh button is clicked", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    const buttons = screen.getAllByRole("button")
    const refreshButton = buttons.find(
      (btn) =>
        btn.querySelector('[class*="lucide-refresh"]') ||
        btn.getAttribute("aria-label")?.includes("refresh")
    )

    if (refreshButton) {
      fireEvent.click(refreshButton)
      expect(mockRefresh).toHaveBeenCalled()
    }
  })

  it("should call onModelSelect when a model is clicked", () => {
    const onModelSelect = jest.fn()
    renderWithProviders(
      <LocalProviderModelManager providerId="ollama" onModelSelect={onModelSelect} />
    )

    const modelButton = screen.getByText("llama3.2").closest("button")
    if (modelButton) {
      fireEvent.click(modelButton)
      expect(onModelSelect).toHaveBeenCalledWith("llama3.2")
    }
  })

  it("should highlight selected model", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" selectedModel="llama3.2" />)

    // The selected model should be in the document
    expect(screen.getByText("llama3.2")).toBeInTheDocument()
  })

  it("should show delete button for each model", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    // Look for trash icons
    const deleteButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.querySelector('[class*="lucide-trash"]'))

    expect(deleteButtons.length).toBeGreaterThan(0)
  })

  // TODO: Fix dropdown behavior in test environment
  it.skip("should show popular models dropdown for Ollama", async () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    const popularModelsButton = screen.getByText("Popular Models")
    fireEvent.click(popularModelsButton)

    await waitFor(() => {
      expect(screen.getByText("llama3.2")).toBeInTheDocument()
    })
  })

  // TODO: Fix compact mode rendering in test environment
  it.skip("should render compact version", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" compact={true} />)

    // Compact version should show model badges
    expect(screen.getByText("llama3.2")).toBeInTheDocument()
    // But not the full card header
    expect(screen.queryByText("Ollama Models")).not.toBeInTheDocument()
  })
})

describe("LocalProviderModelManager - Disconnected State", () => {
  beforeEach(() => {
    // Override mock for disconnected state
    const { useLocalProvider } = jest.requireMock("@/hooks/provider/use-local-provider")
    useLocalProvider.mockReturnValue({
      providerId: "ollama",
      config: {
        id: "ollama",
        name: "Ollama",
        defaultBaseURL: "http://localhost:11434",
        description: "Run models locally",
      },
      capabilities: {
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
      },
      status: null,
      isConnected: false,
      isLoading: false,
      error: "Connection refused",
      models: [],
      pullStates: new Map(),
      isPulling: false,
      refresh: mockRefresh,
      pullModel: mockPullModel,
      cancelPull: mockCancelPull,
      deleteModel: mockDeleteModel,
      stopModel: mockStopModel,
    })
  })

  it("should show not running message when disconnected", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText(/providerNotRunning/i)).toBeInTheDocument()
  })

  it("should show install link when disconnected", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText(/installProvider/i)).toBeInTheDocument()
  })
})

describe("LocalProviderModelManager - Pulling State", () => {
  beforeEach(() => {
    const { useLocalProvider } = jest.requireMock("@/hooks/provider/use-local-provider")
    useLocalProvider.mockReturnValue({
      providerId: "ollama",
      config: {
        id: "ollama",
        name: "Ollama",
        defaultBaseURL: "http://localhost:11434",
      },
      capabilities: {
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
      },
      status: { connected: true },
      isConnected: true,
      isLoading: false,
      error: null,
      models: [],
      pullStates: new Map([
        [
          "mistral",
          {
            isActive: true,
            progress: {
              model: "mistral",
              status: "downloading",
              completed: 1000000000,
              total: 4000000000,
            },
          },
        ],
      ]),
      isPulling: true,
      refresh: mockRefresh,
      pullModel: mockPullModel,
      cancelPull: mockCancelPull,
      deleteModel: mockDeleteModel,
      stopModel: mockStopModel,
    })
  })

  it("should show pull progress", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText("mistral")).toBeInTheDocument()
    // Should show progress bar
    expect(screen.getByRole("progressbar")).toBeInTheDocument()
  })

  it("should show cancel button during pull", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    const cancelButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.querySelector('[class*="lucide-x"]'))

    expect(cancelButtons.length).toBeGreaterThan(0)
  })

  it("should call cancelPull when cancel button is clicked", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    const cancelButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.querySelector('[class*="lucide-x"]'))

    if (cancelButtons[0]) {
      fireEvent.click(cancelButtons[0])
      expect(mockCancelPull).toHaveBeenCalledWith("mistral")
    }
  })
})

/** Build a hook return with one pull row in the given state. */
function mockPullState(state: Record<string, unknown>) {
  const { useLocalProvider } = jest.requireMock("@/hooks/provider/use-local-provider")
  useLocalProvider.mockReturnValue({
    providerId: "ollama",
    config: { id: "ollama", name: "Ollama", defaultBaseURL: "http://localhost:11434" },
    capabilities: { canListModels: true, canPullModels: true, canDeleteModels: true },
    status: { connected: true },
    isConnected: true,
    isLoading: false,
    error: null,
    models: [],
    pullStates: new Map([["mistral", { modelName: "mistral", ...state }]]),
    isPulling: Boolean(state.isActive),
    refresh: mockRefresh,
    pullModel: mockPullModel,
    cancelPull: mockCancelPull,
    deleteModel: mockDeleteModel,
    stopModel: mockStopModel,
  })
}

describe("LocalProviderModelManager - pull progress honesty", () => {
  /**
   * Ollama's opening lines ("pulling manifest") carry no byte counts, so there
   * is no percentage to draw. NO BAR may render here — `components/ui/progress`
   * renders `value || 0`, so a bar with an omitted value is pixel-identical to
   * a definite 0%, i.e. it would state a number we do not have. A spinner is
   * the honest affordance, and its absence/presence is what these two tests
   * discriminate on. (Asserting `aria-valuenow` would NOT work: that Progress
   * never forwards `value` to Radix, so the attribute is absent in both states
   * and the test would pass vacuously.)
   */
  it("shows a spinner and no progress bar while the server has sent no byte counts", () => {
    mockPullState({ status: "pulling", isActive: true, percentage: 0, indeterminate: true })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("pullStarting")
  })

  it("shows a real bar, not a spinner, once the server reports totals", () => {
    mockPullState({
      status: "pulling",
      isActive: true,
      percentage: 25,
      indeterminate: false,
      progress: { model: "mistral", status: "downloading", completed: 1000, total: 4000 },
    })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByRole("progressbar")).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  /**
   * THE honesty case. Ollama's server cannot cancel a pull — the bytes keep
   * arriving (ollama#13142). The row previously unmounted on cancel, so the
   * user saw it vanish and concluded the download had stopped. It must stay and
   * say otherwise.
   */
  it("keeps a cancelled row visible and says the download continues in the background", () => {
    mockPullState({ status: "cancelled", isActive: false, percentage: 30, indeterminate: false })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText("mistral")).toBeInTheDocument()
    expect(screen.getByText("pullContinuesInBackground")).toBeInTheDocument()
  })

  it("offers no stop-progress button once a pull is no longer active", () => {
    mockPullState({ status: "cancelled", isActive: false, percentage: 30, indeterminate: false })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    const xButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.querySelector('[class*="lucide-x"]'))
    expect(xButtons).toHaveLength(0)
  })

  it("drops a completed row — the model list is the receipt", () => {
    mockPullState({ status: "completed", isActive: false, percentage: 100, indeterminate: false })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.queryByText("mistral")).not.toBeInTheDocument()
  })

  /** The hook returns a code; the component owns the translation. */
  it("translates a hook error code rather than printing it raw", () => {
    mockPullState({
      status: "error",
      isActive: false,
      percentage: 0,
      indeterminate: false,
      error: "pull-failed",
    })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText("pullFailed")).toBeInTheDocument()
    expect(screen.queryByText("pull-failed")).not.toBeInTheDocument()
  })

  it("passes server/exception text through untranslated", () => {
    mockPullState({
      status: "error",
      isActive: false,
      percentage: 0,
      indeterminate: false,
      error: "ECONNREFUSED",
    })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    expect(screen.getByText("ECONNREFUSED")).toBeInTheDocument()
  })
})

describe("LocalProviderModelManager - probed capabilities", () => {
  beforeEach(() => {
    mockCapabilities.clear()
    const { useLocalProvider } = jest.requireMock("@/hooks/provider/use-local-provider")
    useLocalProvider.mockReturnValue({
      providerId: "ollama",
      config: { id: "ollama", name: "Ollama", defaultBaseURL: "http://localhost:11434" },
      capabilities: { canListModels: true, canPullModels: true, canDeleteModels: true },
      status: { connected: true },
      isConnected: true,
      isLoading: false,
      error: null,
      models: [{ id: "qwen2.5-vl:7b", object: "model", size: 1000 }],
      pullStates: new Map(),
      isPulling: false,
      refresh: mockRefresh,
      pullModel: mockPullModel,
      cancelPull: mockCancelPull,
      deleteModel: mockDeleteModel,
      stopModel: mockStopModel,
    })
  })

  it("badges what the server reported the model can do", () => {
    mockCapabilities.set("qwen2.5-vl:7b", {
      supportsVision: true,
      supportsTools: true,
      supportsEmbedding: false,
      supportsThinking: false,
      contextLength: 131072,
      inferred: false,
    })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    // A name-substring guess would call qwen2.5-vl text-only; the probe knows better.
    expect(screen.getByText("capabilityVision")).toBeInTheDocument()
    expect(screen.getByText("capabilityTools")).toBeInTheDocument()
    expect(screen.queryByText("capabilityEmbedding")).not.toBeInTheDocument()
  })

  it("marks a name-guess as uncertain instead of passing it off as a probe result", () => {
    mockCapabilities.set("qwen2.5-vl:7b", {
      supportsVision: true,
      supportsTools: false,
      supportsEmbedding: false,
      supportsThinking: false,
      inferred: true,
    })
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)

    const badge = screen.getByText(/capabilityVision/)
    expect(badge.textContent).toContain("?")
    expect(badge.getAttribute("title")).toBe("capabilityInferredHint")
  })

  /** An absent badge means "we did not ask", never "it cannot". */
  it("shows no badges before the probe answers", () => {
    renderWithProviders(<LocalProviderModelManager providerId="ollama" />)
    expect(screen.queryByText("capabilityVision")).not.toBeInTheDocument()
  })
})
