/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CustomProviderDialog } from "./custom-provider-dialog"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock stores - use stable references to avoid infinite loops
const mockAddCustomProvider = jest.fn()
const mockUpdateCustomProvider = jest.fn()
const mockRemoveCustomProvider = jest.fn()
const mockDiscoverOpenAICompatibleModels = jest.fn()
const mockCustomProviders: Record<string, unknown>[] = []

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      customProviders: mockCustomProviders,
      addCustomProvider: mockAddCustomProvider,
      updateCustomProvider: mockUpdateCustomProvider,
      removeCustomProvider: mockRemoveCustomProvider,
    }
    return selector(state)
  },
}))

jest.mock("@cognia/provider-core/providers/model-discovery", () => {
  const actual = jest.requireActual("@cognia/provider-core/providers/model-discovery")
  return {
    ...actual,
    discoverOpenAICompatibleModels: (...args: unknown[]) =>
      mockDiscoverOpenAICompatibleModels(...args),
  }
})

jest.mock("@/lib/ai/infrastructure/api-test", () => ({
  testCustomProviderConnectionByProtocol: jest.fn().mockResolvedValue({ success: true }),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const apiTest = require("@/lib/ai/infrastructure/api-test") as {
  testCustomProviderConnectionByProtocol: jest.Mock
}

// Mock UI components
jest.mock("@/components/ui/button")

jest.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    placeholder,
    type,
    id,
  }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      type={type}
      id={id}
      data-testid={id || "input"}
    />
  ),
}))

jest.mock("@/components/ui/label")

jest.mock("@/components/ui/badge")

jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <div data-testid="api-protocol-select" data-value={value}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: React.ReactNode; value: string }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <>{placeholder}</>,
}))

jest.mock("@/components/ui/dialog")

describe("CustomProviderDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    editingProviderId: null,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockAddCustomProvider.mockResolvedValue("custom-provider")
    mockUpdateCustomProvider.mockResolvedValue(undefined)
    mockRemoveCustomProvider.mockResolvedValue(undefined)
    mockCustomProviders.length = 0
  })

  it("renders when open", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("does not render when closed", () => {
    render(<CustomProviderDialog {...defaultProps} open={false} />)
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
  })

  it("displays add provider title when not editing", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("addCustomProvider")).toBeInTheDocument()
  })

  it("lists plugin-contributed protocol adapters in the protocol picker", async () => {
    const { registerProtocolAdapter, __resetProtocolAdaptersForTesting } =
      await import("@cognia/provider-core/providers/protocol-adapter-registry")
    registerProtocolAdapter(
      {
        id: "acme-plugin:wire",
        label: "Acme Wire",
        spec: {
          kind: "openai-compatible-variant",
          urlTemplate: "{baseURL}/chat",
          responsePaths: { textDelta: "choices[0].delta.content" },
        },
      },
      { pluginId: "acme-plugin" }
    )
    try {
      render(<CustomProviderDialog {...defaultProps} />)
      expect(screen.getByText("Acme Wire")).toBeInTheDocument()
      // Built-ins are still present alongside.
      expect(screen.getByText("OpenAI")).toBeInTheDocument()
    } finally {
      __resetProtocolAdaptersForTesting()
    }
  })

  it("displays provider name input", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("providerName")).toBeInTheDocument()
  })

  it("displays base URL input", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("baseURL")).toBeInTheDocument()
  })

  it("displays API key input", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("apiKey")).toBeInTheDocument()
  })

  it("displays models section", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("models")).toBeInTheDocument()
  })

  it("displays save button", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("save")).toBeInTheDocument()
  })

  it("displays cancel button", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("cancel")).toBeInTheDocument()
  })

  it("displays test button", () => {
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("test")).toBeInTheDocument()
  })

  it("shows the OpenAI endpoint-family (apiFlavor) picker for the openai protocol", () => {
    // Default protocol is openai → the Responses/Chat override is offered.
    render(<CustomProviderDialog {...defaultProps} />)
    expect(screen.getByText("apiFlavor")).toBeInTheDocument()
    expect(screen.getByText("apiFlavorResponses")).toBeInTheDocument()
    expect(screen.getByText("apiFlavorChat")).toBeInTheDocument()
  })

  it("loads a saved apiFlavor when editing an openai custom provider", async () => {
    mockCustomProviders.push({
      id: "custom-resp",
      providerId: "custom-resp",
      customName: "Azure Custom",
      name: "Azure Custom",
      isCustom: true,
      baseURL: "https://x.openai.azure.com",
      apiKey: "az-key",
      apiProtocol: "openai",
      apiFlavor: "responses",
      customModels: ["gpt-5"],
      defaultModel: "gpt-5",
      enabled: true,
    })

    render(<CustomProviderDialog {...defaultProps} editingProviderId="custom-resp" />)

    // Source seeds via setTimeout(0); the flavor Select wrapper carries the
    // loaded value once hydrated (both protocol + flavor share the mock testid).
    await waitFor(() => {
      const selects = screen.getAllByTestId("api-protocol-select")
      expect(selects.some((el) => el.getAttribute("data-value") === "responses")).toBe(true)
    })
  })

  it("loads discovered models for remote-only custom providers when editing", async () => {
    mockCustomProviders.push({
      id: "custom-discovered",
      providerId: "custom-discovered",
      customName: "Remote Custom",
      name: "Remote Custom",
      isCustom: true,
      baseURL: "https://custom.example.com/v1",
      apiKey: "sk-custom",
      apiProtocol: "openai",
      customModels: [],
      discoveredModels: [
        {
          id: "provider/alpha-1",
          name: "Alpha 1",
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
      discoveredModelsLastFetched: 1_700_000_000_000,
      defaultModel: "provider/alpha-1",
      enabled: true,
    })

    render(<CustomProviderDialog {...defaultProps} editingProviderId="custom-discovered" />)

    // Source seeds via setTimeout(0); wait for hydration before asserting.
    await waitFor(() => {
      expect(screen.getByText("Alpha 1")).toBeInTheDocument()
    })
  })

  it("keeps an edited provider open until the update is persisted", async () => {
    let resolveUpdate: (() => void) | undefined
    mockUpdateCustomProvider.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveUpdate = resolve))
    )
    mockCustomProviders.push({
      id: "custom-pending",
      providerId: "custom-pending",
      customName: "Pending Provider",
      name: "Pending Provider",
      isCustom: true,
      baseURL: "https://custom.example.com/v1",
      apiKey: "sk-custom",
      apiProtocol: "openai",
      customModels: ["model-1"],
      defaultModel: "model-1",
      enabled: true,
    })
    const onOpenChange = jest.fn()
    render(
      <CustomProviderDialog open onOpenChange={onOpenChange} editingProviderId="custom-pending" />
    )
    await waitFor(() => expect(screen.getByDisplayValue("Pending Provider")).toBeInTheDocument())

    fireEvent.click(screen.getByText("save"))
    expect(screen.getByText("saving")).toBeDisabled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    resolveUpdate?.()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("preserves the editor and reports a failed provider mutation", async () => {
    mockUpdateCustomProvider.mockRejectedValueOnce(new Error("database unavailable"))
    mockCustomProviders.push({
      id: "custom-failed",
      providerId: "custom-failed",
      customName: "Failed Provider",
      name: "Failed Provider",
      isCustom: true,
      baseURL: "https://custom.example.com/v1",
      apiKey: "sk-custom",
      apiProtocol: "openai",
      customModels: ["model-1"],
      defaultModel: "model-1",
      enabled: true,
    })
    const onOpenChange = jest.fn()
    render(
      <CustomProviderDialog open onOpenChange={onOpenChange} editingProviderId="custom-failed" />
    )
    await waitFor(() => expect(screen.getByDisplayValue("Failed Provider")).toBeInTheDocument())

    fireEvent.click(screen.getByText("save"))

    expect(await screen.findByRole("alert")).toHaveTextContent("customProviderMutationFailed")
    expect(screen.getByDisplayValue("Failed Provider")).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("persists shared discovered model cache after refreshing openai-compatible models", async () => {
    mockDiscoverOpenAICompatibleModels.mockResolvedValue([
      {
        id: "provider/alpha-1",
        name: "Alpha 1",
        contextLength: 64000,
        supportsTools: true,
        supportsStreaming: true,
      },
    ])

    render(<CustomProviderDialog {...defaultProps} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    fireEvent.change(screen.getByTestId("provider-name"), {
      target: { value: "Remote Custom" },
    })
    fireEvent.change(screen.getByTestId("base-url"), {
      target: { value: "https://custom.example.com/v1" },
    })
    fireEvent.change(screen.getByTestId("api-key"), {
      target: { value: "sk-custom" },
    })
    fireEvent.click(screen.getByRole("button", { name: "clickRefreshToLoad" }))

    await waitFor(() => {
      expect(mockDiscoverOpenAICompatibleModels).toHaveBeenCalledWith({
        baseURL: "https://custom.example.com/v1",
        apiKey: "sk-custom",
      })
    })

    // Discovery state is committed asynchronously; wait until the save button
    // re-enables (i.e. availableModels.length > 0 has propagated) before
    // firing the save click.
    await waitFor(() => {
      expect(screen.getByText("save")).not.toBeDisabled()
    })

    fireEvent.click(screen.getByText("save"))

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          customName: "Remote Custom",
          baseURL: "https://custom.example.com/v1",
          apiKey: "sk-custom",
          apiProtocol: "openai",
          customModels: [],
          discoveredModels: [
            expect.objectContaining({
              id: "provider/alpha-1",
              name: "Alpha 1",
            }),
          ],
          discoveredModelsLastFetched: expect.any(Number),
          defaultModel: "provider/alpha-1",
          enabled: true,
        })
      )
    })
  })

  describe("connection test (shared useConnectionTest hook)", () => {
    // The dialog's mount effect schedules a `setTimeout(...,0)` field reset
    // (see the "Load data when editing" effect). Flush it before typing so
    // the reset doesn't race and clobber the values fired below.
    async function renderAndFlushMountReset() {
      render(<CustomProviderDialog {...defaultProps} />)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })
    }

    it("shows the ConnectionStatusCard success state and forwards latency", async () => {
      apiTest.testCustomProviderConnectionByProtocol.mockResolvedValueOnce({
        success: true,
        message: "Connected successfully.",
        latency_ms: 88,
      })
      await renderAndFlushMountReset()
      fireEvent.change(screen.getByTestId("base-url"), {
        target: { value: "https://custom.example.com/v1" },
      })
      fireEvent.change(screen.getByTestId("api-key"), { target: { value: "sk-x" } })
      fireEvent.click(screen.getByText("test"))

      expect(await screen.findByText("configTab.connectionSuccess")).toBeInTheDocument()
      expect(screen.getByText(/88/)).toBeInTheDocument()
    })

    it("shows the ConnectionStatusCard error state with the failure message", async () => {
      apiTest.testCustomProviderConnectionByProtocol.mockResolvedValueOnce({
        success: false,
        message: "API error: 401",
      })
      await renderAndFlushMountReset()
      fireEvent.change(screen.getByTestId("base-url"), {
        target: { value: "https://custom.example.com/v1" },
      })
      fireEvent.change(screen.getByTestId("api-key"), { target: { value: "bad-key" } })
      fireEvent.click(screen.getByText("test"))

      expect(await screen.findByText("configTab.connectionFailed")).toBeInTheDocument()
      expect(screen.getByText("API error: 401")).toBeInTheDocument()
    })

    it("shows the amber 'limited' state instead of collapsing it into success", async () => {
      apiTest.testCustomProviderConnectionByProtocol.mockResolvedValueOnce({
        success: true,
        outcome: "limited",
        message: "Verified with caveats.",
      })
      await renderAndFlushMountReset()
      fireEvent.change(screen.getByTestId("base-url"), {
        target: { value: "https://custom.example.com/v1" },
      })
      fireEvent.change(screen.getByTestId("api-key"), { target: { value: "sk-x" } })
      fireEvent.click(screen.getByText("test"))

      expect(await screen.findByText("verificationLimited")).toBeInTheDocument()
      expect(screen.queryByText("configTab.connectionSuccess")).not.toBeInTheDocument()
    })

    it("clears a stale result when the base URL is edited again", async () => {
      apiTest.testCustomProviderConnectionByProtocol.mockResolvedValueOnce({
        success: false,
        message: "API error: 401",
      })
      await renderAndFlushMountReset()
      fireEvent.change(screen.getByTestId("base-url"), {
        target: { value: "https://custom.example.com/v1" },
      })
      fireEvent.change(screen.getByTestId("api-key"), { target: { value: "bad-key" } })
      fireEvent.click(screen.getByText("test"))
      expect(await screen.findByText("configTab.connectionFailed")).toBeInTheDocument()

      fireEvent.change(screen.getByTestId("base-url"), {
        target: { value: "https://retry.example.com/v1" },
      })
      expect(screen.queryByText("configTab.connectionFailed")).not.toBeInTheDocument()
    })
  })
})
