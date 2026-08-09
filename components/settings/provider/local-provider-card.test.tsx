/**
 * Tests for LocalProviderCard component
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LocalProviderCard } from "./local-provider-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    if (key === "localProviderDescriptions.ollama") {
      return "Run models locally with easy model management"
    }
    const translations: Record<string, string> = {
      connected: "Connected",
      disconnected: "Not connected",
      configuration: "Configuration",
      serverUrl: "Server URL",
      setupGuide: "Setup guide",
      capabilityChatApi: "Chat API",
      capabilityModelList: "List Models",
      capabilityModelPull: "Pull Models",
      capabilityModelDelete: "Delete",
      capabilityModelUnload: "Unload",
      manageModels: "Manage Models",
      providerDocumentation: "Provider documentation",
      resetToDefault: "Reset to default",
      supported: "Supported",
      notSupported: "Not supported",
      default: "Default",
      modelsCount: "models",
    }
    return translations[key] || key
  },
}))

const renderWithProviders = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

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
  },
}))

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
  getProviderCapabilities: (...args: unknown[]) => getProviderCapabilities(...(args as [])),
  getInstallInstructions: jest.fn(() => ({
    title: "Install Ollama",
    steps: ["Download", "Install", "Run"],
    downloadUrl: "https://ollama.ai/download",
    docsUrl: "https://ollama.ai/docs",
    modelsUrl: "https://ollama.ai/library",
  })),
}))

describe("LocalProviderCard", () => {
  const defaultProps = {
    providerId: "ollama" as const,
    enabled: true,
    baseUrl: "http://localhost:11434",
    isConnected: true,
    isLoading: false,
    version: "0.1.0",
    modelsCount: 5,
    latency: 50,
    error: undefined,
    onToggle: jest.fn(),
    onBaseUrlChange: jest.fn(),
    onTestConnection: jest.fn().mockResolvedValue({ success: true, message: "Connected" }),
    onManageModels: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders provider details and connection summary", () => {
    renderWithProviders(<LocalProviderCard {...defaultProps} />)

    expect(screen.getByText("Ollama")).toBeInTheDocument()
    expect(screen.getByText(/Run models locally/)).toBeInTheDocument()
    expect(screen.getByText("v0.1.0")).toBeInTheDocument()
    expect(screen.getByText(/Connected/)).toBeInTheDocument()
    expect(screen.getByText(/5 models/)).toBeInTheDocument()
  })

  it("renders conservative provider-level badges only", () => {
    renderWithProviders(<LocalProviderCard {...defaultProps} />)

    expect(screen.getByText("Chat API")).toBeInTheDocument()
    expect(screen.getByText("List Models")).toBeInTheDocument()
    expect(screen.getByText("Pull Models")).toBeInTheDocument()
    expect(screen.getByText("Delete")).toBeInTheDocument()
    expect(screen.getByText("Unload")).toBeInTheDocument()
    expect(screen.queryByText("Vision")).not.toBeInTheDocument()
    expect(screen.queryByText("Tools")).not.toBeInTheDocument()
    expect(screen.queryByText("Embed")).not.toBeInTheDocument()
  })

  it("calls onToggle when the switch is clicked", () => {
    renderWithProviders(<LocalProviderCard {...defaultProps} />)

    fireEvent.click(screen.getByRole("switch"))
    expect(defaultProps.onToggle).toHaveBeenCalledWith(false)
  })

  it("shows and triggers the setup guide button when provided", () => {
    const onSetup = jest.fn()
    renderWithProviders(<LocalProviderCard {...defaultProps} onSetup={onSetup} />)

    fireEvent.click(screen.getByRole("button", { name: "Setup guide" }))
    expect(onSetup).toHaveBeenCalledTimes(1)
  })

  it("hides the manage-models button when model management is not wired", () => {
    renderWithProviders(<LocalProviderCard {...defaultProps} onManageModels={undefined} />)

    expect(screen.queryByText("Manage Models")).not.toBeInTheDocument()
  })

  it("expands configuration and persists base URL changes on blur", async () => {
    renderWithProviders(<LocalProviderCard {...defaultProps} />)

    fireEvent.click(screen.getByText("Configuration"))
    const input = await screen.findByDisplayValue("http://localhost:11434")
    fireEvent.change(input, { target: { value: "http://127.0.0.1:11500" } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(defaultProps.onBaseUrlChange).toHaveBeenCalledWith("http://127.0.0.1:11500")
    })
  })

  it("shows a compact variant without the full description", () => {
    renderWithProviders(<LocalProviderCard {...defaultProps} compact />)

    expect(screen.getByRole("switch")).toBeInTheDocument()
    expect(
      screen.queryByText(/Run models locally with easy model management/)
    ).not.toBeInTheDocument()
  })
})
