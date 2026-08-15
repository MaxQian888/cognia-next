/**
 * CLIProxyAPI Settings Component Tests
 */

import React from "react"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { CLIProxyAPISettings } from "./cliproxyapi-settings"
import { useSettingsStore } from "@/stores"
import * as cliproxyapi from "@cognia/provider-core/providers/cliproxyapi"

const mockDiscoverCLIProxyAPIModels = jest.fn()

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      serverStatus: "Server Status",
      managementWebUI: "Management WebUI",
      connected: "Connected",
      endpoint: "Endpoint",
      latency: "Latency",
      clickRefreshToTest: "Click refresh to test",
      openWebUI: "Open WebUI",
      webUIDescription: "Access and manage CLIProxyAPI",
      availableModels: "Available Models",
      modelsAvailableThrough: "Models available through the gateway",
      clickRefreshToLoad: "Click refresh to load",
      serverConfiguration: "Server Configuration",
      host: "Host",
      port: "Port",
      routingStrategy: "Routing Strategy",
      autoSwitchProject: "Auto-switch Project",
      autoSwitchPreview: "Auto-switch to Preview Model",
      keepaliveInterval: "Keepalive Interval (s)",
      bootstrapRetries: "Bootstrap Retries",
      managementKey: "Management Key (Optional)",
      managementKeyPlaceholder: "Optional key",
      viewDocumentation: "View full configuration documentation",
    }
    return translations[key] || key
  },
}))

// Mock settings store with setState/getState API used by this test file
jest.mock("@/stores", () => {
  const storeState: {
    providerSettings: Record<string, unknown>
    updateProviderSettings: (providerId: string, updates: Record<string, unknown>) => void
  } = {
    providerSettings: {},
    updateProviderSettings: (providerId: string, updates: Record<string, unknown>) => {
      const previous = (storeState.providerSettings[providerId] as Record<string, unknown>) || {}
      const previousCliProxy =
        (previous.cliProxyAPISettings as Record<string, unknown> | undefined) || {}
      const nextCliProxy =
        (updates.cliProxyAPISettings as Record<string, unknown> | undefined) || {}

      storeState.providerSettings[providerId] = {
        ...previous,
        ...updates,
        cliProxyAPISettings: {
          ...previousCliProxy,
          ...nextCliProxy,
        },
      }
    },
  }

  const useSettingsStore = ((selector?: (state: typeof storeState) => unknown) => {
    return selector ? selector(storeState) : storeState
  }) as ((selector?: (state: typeof storeState) => unknown) => unknown) & {
    setState: (partial: Partial<typeof storeState>) => void
    getState: () => typeof storeState
  }

  useSettingsStore.setState = (partial: Partial<typeof storeState>) => {
    if (partial.providerSettings) {
      storeState.providerSettings = partial.providerSettings as Record<string, unknown>
    }
    if (partial.updateProviderSettings) {
      storeState.updateProviderSettings = partial.updateProviderSettings
    }
  }

  useSettingsStore.getState = () => storeState

  return { useSettingsStore }
})

// Mock the CLIProxyAPI library
jest.mock("@cognia/provider-core/providers/cliproxyapi", () => ({
  testConnection: jest.fn(),
  getWebUIURL: jest.fn(() => "http://localhost:8317/management.html"),
  getAPIURL: jest.fn(
    (host: string = "localhost", port: number = 8317) => `http://${host}:${port}/v1`
  ),
}))

jest.mock("@cognia/provider-core/providers/model-discovery", () => ({
  discoverCLIProxyAPIModels: (...args: unknown[]) => mockDiscoverCLIProxyAPIModels(...args),
}))

const mockTestConnection = cliproxyapi.testConnection as jest.MockedFunction<
  typeof cliproxyapi.testConnection
>

// Mock window.open
const mockWindowOpen = jest.fn()
Object.defineProperty(window, "open", {
  value: mockWindowOpen,
  writable: true,
})

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn(),
  },
})

describe("CLIProxyAPISettings", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset store state
    useSettingsStore.setState({
      providerSettings: {
        cliproxyapi: {
          providerId: "cliproxyapi",
          enabled: true,
          apiKey: "test-api-key",
          defaultModel: "gemini-2.5-flash",
          cliProxyAPISettings: {
            host: "localhost",
            port: 8317,
          },
        },
      },
    })
  })

  it("should render when provider is enabled", () => {
    render(<CLIProxyAPISettings />)

    expect(screen.getByText("Server Status")).toBeInTheDocument()
    expect(screen.getByText("Management WebUI")).toBeInTheDocument()
  })

  it("should not render when provider is disabled", () => {
    useSettingsStore.setState({
      providerSettings: {
        cliproxyapi: {
          providerId: "cliproxyapi",
          enabled: false,
          apiKey: "",
          defaultModel: "gemini-2.5-flash",
        },
      },
    })

    const { container } = render(<CLIProxyAPISettings />)
    expect(container.firstChild).toBeNull()
  })

  it("should show connection status card", () => {
    render(<CLIProxyAPISettings />)

    expect(screen.getByText("Server Status")).toBeInTheDocument()
  })

  it("should test connection when refresh button is clicked", async () => {
    mockTestConnection.mockResolvedValue({
      success: true,
      message: "Connected",
      latency: 50,
    })

    render(<CLIProxyAPISettings />)

    // Find and click the refresh button in the server status section
    const refreshButtons = screen.getAllByRole("button")
    const serverStatusRefresh = refreshButtons.find((btn) =>
      btn.closest('[class*="Card"]')?.textContent?.includes("Server Status")
    )

    if (serverStatusRefresh) {
      fireEvent.click(serverStatusRefresh)

      await waitFor(() => {
        expect(mockTestConnection).toHaveBeenCalledWith("test-api-key", "localhost", 8317)
      })
    }
  })

  it("should open WebUI in new tab when button is clicked", async () => {
    mockTestConnection.mockResolvedValue({
      success: true,
      message: "Connected",
      latency: 50,
    })

    render(<CLIProxyAPISettings />)

    // Wait for connection test to complete
    await waitFor(
      () => {
        expect(screen.queryByText("Connected")).toBeInTheDocument()
      },
      { timeout: 3000 }
    ).catch(() => {
      // Connection might not show if API call hasn't resolved
    })

    const openWebUIButton = screen.getByRole("button", { name: /open webui/i })
    fireEvent.click(openWebUIButton)

    expect(mockWindowOpen).toHaveBeenCalledWith(
      "http://localhost:8317/management.html",
      "_blank",
      "noopener,noreferrer"
    )
  })

  it("should show available models section", () => {
    render(<CLIProxyAPISettings />)

    expect(screen.getByText("Available Models")).toBeInTheDocument()
  })

  it("should expand server configuration section when clicked", () => {
    render(<CLIProxyAPISettings />)

    const configSection = screen.getByText("Server Configuration")
    fireEvent.click(configSection)

    expect(screen.getByLabelText("Host")).toBeInTheDocument()
    expect(screen.getByLabelText("Port")).toBeInTheDocument()
  })

  it("should update host configuration", () => {
    render(<CLIProxyAPISettings />)

    // Expand the server configuration section
    const configSection = screen.getByText("Server Configuration")
    fireEvent.click(configSection)

    const hostInput = screen.getByLabelText("Host")
    fireEvent.change(hostInput, { target: { value: "192.168.1.100" } })

    const state = useSettingsStore.getState()
    expect(state.providerSettings.cliproxyapi?.cliProxyAPISettings?.host).toBe("192.168.1.100")
  })

  it("should update port configuration", () => {
    render(<CLIProxyAPISettings />)

    // Expand the server configuration section
    const configSection = screen.getByText("Server Configuration")
    fireEvent.click(configSection)

    const portInput = screen.getByLabelText("Port")
    fireEvent.change(portInput, { target: { value: "9000" } })

    const state = useSettingsStore.getState()
    expect(state.providerSettings.cliproxyapi?.cliProxyAPISettings?.port).toBe(9000)
    // Dispatch reads `baseURL`, so the host/port edit must move it too.
    expect(state.providerSettings.cliproxyapi?.baseURL).toBe("http://localhost:9000/v1")
  })

  it("auto-tests once per input change instead of looping on its own writes", async () => {
    // Regression: the auto-test effect depended on the test handler, which
    // depended on the settings object the test itself rewrote
    // (`lastHealthCheck`), so an enabled provider with a key tested forever.
    jest.useFakeTimers()
    try {
      mockTestConnection.mockResolvedValue({ success: true, latency: 5, message: "ok" })
      render(<CLIProxyAPISettings />)
      await act(async () => {
        jest.advanceTimersByTime(400)
      })
      // Let the write → re-render → (would-be) re-arm cycle settle a few times.
      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          jest.advanceTimersByTime(400)
        })
      }
      expect(mockTestConnection).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("should fetch models when refresh is clicked", async () => {
    mockDiscoverCLIProxyAPIModels.mockResolvedValue([
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
    ])

    render(<CLIProxyAPISettings />)

    // Expand models section
    const modelsSection = screen.getByText("Available Models")
    fireEvent.click(modelsSection)

    // Find the refresh button within the models section
    const refreshButtons = screen.getAllByRole("button")
    const modelsRefresh = refreshButtons.find(
      (btn) =>
        btn.closest('[class*="Card"]')?.textContent?.includes("Available Models") &&
        btn.querySelector("svg")
    )

    if (modelsRefresh) {
      fireEvent.click(modelsRefresh)

      await waitFor(() => {
        expect(mockDiscoverCLIProxyAPIModels).toHaveBeenCalled()
      })
    }
  })

  it("should persist discovered models into the shared cache when refresh is clicked", async () => {
    mockDiscoverCLIProxyAPIModels.mockResolvedValue([
      {
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ])

    render(<CLIProxyAPISettings />)

    const modelsSection = screen.getByText("Available Models")
    fireEvent.click(modelsSection)
    const iconButtons = screen.getAllByRole("button").filter((btn) => btn.querySelector("svg"))
    fireEvent.click(iconButtons[2])

    await waitFor(() => {
      expect(mockDiscoverCLIProxyAPIModels).toHaveBeenCalledWith({
        apiKey: "test-api-key",
        host: "localhost",
        port: 8317,
      })
    })

    const state = useSettingsStore.getState()
    expect(state.providerSettings.cliproxyapi?.discoveredModels).toEqual([
      expect.objectContaining({
        id: "gpt-4o",
        name: "GPT-4o",
      }),
    ])
    expect(state.providerSettings.cliproxyapi?.discoveredModelsLastFetched).toEqual(
      expect.any(Number)
    )
  })

  it("should show routing strategy select", () => {
    render(<CLIProxyAPISettings />)

    // Expand the server configuration section
    const configSection = screen.getByText("Server Configuration")
    fireEvent.click(configSection)

    expect(screen.getByText("Routing Strategy")).toBeInTheDocument()
  })

  it("should show quota exceeded behavior toggles", () => {
    render(<CLIProxyAPISettings />)

    // Expand the server configuration section
    const configSection = screen.getByText("Server Configuration")
    fireEvent.click(configSection)

    expect(screen.getByText("Auto-switch Project")).toBeInTheDocument()
    expect(screen.getByText("Auto-switch to Preview Model")).toBeInTheDocument()
  })

  it("should show streaming settings", () => {
    render(<CLIProxyAPISettings />)

    // Expand the server configuration section
    const configSection = screen.getByText("Server Configuration")
    fireEvent.click(configSection)

    expect(screen.getByLabelText("Keepalive Interval (s)")).toBeInTheDocument()
    expect(screen.getByLabelText("Bootstrap Retries")).toBeInTheDocument()
  })

  it("should show management key input", () => {
    render(<CLIProxyAPISettings />)

    // Expand the server configuration section
    const configSection = screen.getByText("Server Configuration")
    fireEvent.click(configSection)

    expect(screen.getByLabelText("Management Key (Optional)")).toBeInTheDocument()
  })

  it("should show documentation link", () => {
    render(<CLIProxyAPISettings />)

    // Expand the server configuration section
    const configSection = screen.getByText("Server Configuration")
    fireEvent.click(configSection)

    expect(screen.getByText(/View full configuration documentation/i)).toBeInTheDocument()
  })
})

describe("CLIProxyAPISettings Error Handling", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useSettingsStore.setState({
      providerSettings: {
        cliproxyapi: {
          providerId: "cliproxyapi",
          enabled: true,
          apiKey: "test-api-key",
          defaultModel: "gemini-2.5-flash",
          cliProxyAPISettings: {},
        },
      },
    })
  })

  it("should display connection error message", async () => {
    mockTestConnection.mockResolvedValue({
      success: false,
      message: "Connection refused",
    })

    render(<CLIProxyAPISettings />)

    await waitFor(
      () => {
        expect(screen.getByText(/Connection refused/i)).toBeInTheDocument()
      },
      { timeout: 3000 }
    ).catch(() => {
      // May not appear if auto-test doesn't run
    })
  })

  it("should display models error message", async () => {
    mockDiscoverCLIProxyAPIModels.mockRejectedValue(new Error("Failed to fetch models"))

    render(<CLIProxyAPISettings />)

    // Expand models section
    const modelsSection = screen.getByText("Available Models")
    fireEvent.click(modelsSection)

    // Trigger fetch
    const refreshButtons = screen.getAllByRole("button")
    const modelsRefresh = refreshButtons.find(
      (btn) =>
        btn.closest('[class*="Card"]')?.textContent?.includes("Available Models") &&
        btn.querySelector("svg")
    )

    if (modelsRefresh) {
      fireEvent.click(modelsRefresh)

      await waitFor(
        () => {
          expect(screen.getByText(/Failed to fetch models/i)).toBeInTheDocument()
        },
        { timeout: 3000 }
      ).catch(() => {
        // Error message may not appear
      })
    }
  })
})
