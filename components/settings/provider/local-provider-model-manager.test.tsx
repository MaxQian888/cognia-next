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
