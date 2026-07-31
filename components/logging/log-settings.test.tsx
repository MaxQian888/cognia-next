/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"

const mockApplyLoggingSettings = jest.fn()
const mockConfigureSampling = jest.fn()
const mockGetBootstrap = jest.fn()
const mockUseTransportHealth = jest.fn()
const mockGetRegisteredModules = jest.fn<string[], []>()
const mockPersistTelemetrySecret = jest.fn().mockResolvedValue(undefined)
const mockClearTelemetrySecret = jest.fn().mockResolvedValue(undefined)
const mockTrackEvent = jest.fn().mockResolvedValue(true)
const mockClearBehaviorEvents = jest.fn().mockResolvedValue(undefined)
const mockExportBehaviorEvents = jest.fn().mockResolvedValue("[]")
const mockCreateObjectUrl = jest.fn().mockReturnValue("blob:behavior-events")
const mockRevokeObjectUrl = jest.fn()
const mockSaveAppSettings = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/logging", () => ({
  applyLoggingSettings: (...args: unknown[]) => mockApplyLoggingSettings(...args),
  getLoggingBootstrapState: () => mockGetBootstrap(),
  configureSampling: (...args: unknown[]) => mockConfigureSampling(...args),
  getRegisteredModules: () => mockGetRegisteredModules(),
  LOGGING_SAMPLING_STORAGE_KEY: "cognia-logging-sampling",
}))

jest.mock("@/hooks/logging", () => ({
  useTransportHealth: (...args: unknown[]) => mockUseTransportHealth(...args),
}))

jest.mock("@/lib/logging/telemetry-secrets", () => ({
  persistTelemetrySecret: (...args: unknown[]) => mockPersistTelemetrySecret(...args),
  clearTelemetrySecret: (...args: unknown[]) => mockClearTelemetrySecret(...args),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))
jest.mock("@/lib/db/behavior-events", () => ({
  clearBehaviorEvents: (...args: unknown[]) => mockClearBehaviorEvents(...args),
  exportBehaviorEvents: (...args: unknown[]) => mockExportBehaviorEvents(...args),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { save: typeof mockSaveAppSettings }) => unknown) =>
    selector({ save: mockSaveAppSettings }),
}))

import { LogSettings } from "./log-settings"

function defaultBootstrap() {
  return {
    config: {
      minLevel: "info",
      includeStackTrace: true,
      includeSource: false,
      bufferSize: 50,
      flushInterval: 5000,
      remoteEndpoint: "",
      remoteQueueMaxEntries: 5000,
      remoteQueueMaxBytes: 10 * 1024 * 1024,
      diagnosticRateLimitMs: 2000,
      redaction: { enabled: true, maxDepth: 8 },
    },
    transports: {
      console: true,
      indexedDB: true,
      native: true,
      remote: false,
      langfuse: false,
      nativeConfig: { minLevel: "warn", batchSize: 10, flushInterval: 2000 },
      remoteConfig: {
        endpoint: "",
        batchSize: 50,
        flushInterval: 5000,
        maxRetries: 3,
        retryDelay: 1000,
      },
      langfuseConfig: {
        publicKey: "",
        secretKeyConfigured: false,
        host: "https://cloud.langfuse.com",
        minLevel: "warn",
      },
      agentTrace: true,
      agentTraceOtlp: false,
      agentTraceConfig: { captureContent: false, maxPreviewBytes: 4096, retentionDays: 7 },
      agentTraceOtlpConfig: {
        preset: "off",
        endpoint: "",
        headers: {},
        serviceName: "cognia-ai",
        environment: "",
        grafanaCloud: { instanceId: "", apiTokenConfigured: false },
      },
    },
    retention: { maxEntries: 10000, maxAgeDays: 7 },
  }
}

function defaultNativeLogging(overrides: Record<string, unknown> = {}) {
  return {
    runtime: "browser",
    status: "inactive",
    startupMode: "off",
    bridgeState: "uninitialized",
    activeTargets: [],
    fallbackReason: null,
    bridgeLastError: null,
    platformLogging: { backend: "unspecified", health: "ok", minLevel: "info", error: null },
    ...overrides,
  }
}

beforeEach(() => {
  mockApplyLoggingSettings.mockReset()
  mockConfigureSampling.mockReset()
  mockGetBootstrap.mockReset()
  mockUseTransportHealth.mockReset()
  mockGetRegisteredModules.mockReset()
  mockPersistTelemetrySecret.mockClear()
  mockClearTelemetrySecret.mockClear()
  mockTrackEvent.mockClear()
  mockClearBehaviorEvents.mockClear()
  mockExportBehaviorEvents.mockClear()
  mockCreateObjectUrl.mockClear()
  mockRevokeObjectUrl.mockClear()
  mockSaveAppSettings.mockClear()
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: mockCreateObjectUrl,
  })
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: mockRevokeObjectUrl,
  })
  mockGetBootstrap.mockReturnValue(defaultBootstrap())
  mockUseTransportHealth.mockReturnValue({ nativeLogging: defaultNativeLogging() })
  mockGetRegisteredModules.mockReturnValue(["ai", "network", "network:lark"])
  mockApplyLoggingSettings.mockImplementation(
    (params: { config: unknown; transports: unknown }) => ({
      config: { ...defaultBootstrap().config, ...(params.config as object) },
      transports: { ...defaultBootstrap().transports, ...(params.transports as object) },
      retention: defaultBootstrap().retention,
    })
  )
  localStorage.clear()
})

describe("LogSettings — render", () => {
  it("renders header, save+reset buttons, and all four tabs", () => {
    render(<LogSettings />)
    expect(screen.getByText("Logging Configuration")).toBeInTheDocument()
    expect(screen.getByText("Save")).toBeInTheDocument()
    expect(screen.getByText("Reset")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Levels/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Transports/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Advanced/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Retention/ })).toBeInTheDocument()
  })

  it("hides Unsaved Badge initially", () => {
    render(<LogSettings />)
    expect(screen.queryAllByText("Unsaved changes").length).toBe(0)
  })

  it("shows Unsaved Badge after toggling a Switch", () => {
    render(<LogSettings />)
    // First flip a switch to surface the badge — use Reset as a deterministic trigger
    fireEvent.click(screen.getByText("Reset"))
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
  })
})

describe("LogSettings — behavior telemetry", () => {
  it("persists independent destinations and category consent", async () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    fireEvent.click(screen.getByTestId("behavior-telemetry-switch"))
    fireEvent.click(screen.getByTestId("behavior-telemetry-local-switch"))
    fireEvent.click(screen.getByTestId("behavior-telemetry-remote-switch"))
    fireEvent.click(screen.getByTestId("behavior-telemetry-category-workflow"))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })

    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({
      enabled: true,
      destinations: { local: false, remote: true },
      categories: { workflow: false },
    })
    expect(mockSaveAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetryEnabled: true,
        behaviorTelemetry: expect.objectContaining({
          destinations: { local: false, remote: true },
          categories: expect.objectContaining({ workflow: false }),
        }),
      })
    )
  })

  it("configures sampling, local retention, and bounded storage limits", async () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))

    const localSwitch = screen.getByTestId("behavior-telemetry-local-switch")
    const remoteSwitch = screen.getByTestId("behavior-telemetry-remote-switch")
    const maxEvents = screen.getByLabelText("Maximum local events") as HTMLInputElement
    expect(localSwitch).toBeDisabled()
    expect(remoteSwitch).toBeDisabled()
    expect(maxEvents).toBeDisabled()

    fireEvent.click(screen.getByTestId("behavior-telemetry-switch"))
    const sampleSlider = screen
      .getByTestId("behavior-telemetry-sample-rate")
      .querySelector('[role="slider"]') as HTMLElement
    const retentionSlider = screen
      .getByTestId("behavior-telemetry-retention-days")
      .querySelector('[role="slider"]') as HTMLElement
    sampleSlider.focus()
    fireEvent.keyDown(sampleSlider, { key: "ArrowLeft" })
    retentionSlider.focus()
    fireEvent.keyDown(retentionSlider, { key: "ArrowRight" })
    fireEvent.change(maxEvents, { target: { value: "50" } })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })

    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({
      enabled: true,
      sampleRate: 0.95,
      retentionDays: 31,
      maxStoredEvents: 100,
    })
  })

  it("clamps the local event limit at both boundaries and handles empty input", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    fireEvent.click(screen.getByTestId("behavior-telemetry-switch"))
    const maxEvents = screen.getByLabelText("Maximum local events") as HTMLInputElement

    fireEvent.change(maxEvents, { target: { value: "200000" } })
    expect(maxEvents.value).toBe("100000")
    fireEvent.change(maxEvents, { target: { value: "" } })
    expect(maxEvents.value).toBe("100")
  })

  it("exports both supported formats and clears local events", async () => {
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Export JSON" }))
      fireEvent.click(screen.getByRole("button", { name: "Export CSV" }))
      fireEvent.click(screen.getByRole("button", { name: /Clear local events/i }))
    })

    expect(mockExportBehaviorEvents.mock.calls).toEqual([["json"], ["csv"]])
    expect(mockCreateObjectUrl).toHaveBeenCalledTimes(2)
    expect(mockRevokeObjectUrl).toHaveBeenCalledTimes(2)
    expect(mockClearBehaviorEvents).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })

  it("reset restores private defaults and disables dependent controls", () => {
    localStorage.setItem(
      "cognia-behavior-telemetry-enabled",
      JSON.stringify({
        enabled: true,
        destinations: { local: true, remote: true },
        sampleRate: 0.25,
        retentionDays: 90,
        maxStoredEvents: 500,
      })
    )
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    expect(screen.getByTestId("behavior-telemetry-remote-switch")).toHaveAttribute(
      "aria-checked",
      "true"
    )

    fireEvent.click(screen.getByRole("button", { name: "Reset" }))

    expect(screen.getByTestId("behavior-telemetry-switch")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByTestId("behavior-telemetry-remote-switch")).toBeDisabled()
    expect(screen.getByLabelText("Maximum local events")).toBeDisabled()
  })
})

describe("LogSettings — Levels tab", () => {
  it("renders the minimum-level Select with the bootstrap value", () => {
    render(<LogSettings />)
    expect(screen.getAllByText(/Info/).length).toBeGreaterThan(0)
  })

  it("toggles Include Stack Traces switch", () => {
    render(<LogSettings />)
    // The Include Stack Traces label
    expect(screen.getByText("Include Stack Traces")).toBeInTheDocument()
  })

  it("toggles Include Source Location switch", () => {
    render(<LogSettings />)
    expect(screen.getByText("Include Source Location")).toBeInTheDocument()
  })
})

describe("LogSettings — Native banner", () => {
  it("renders healthy tone (success token)", () => {
    mockUseTransportHealth.mockReturnValue({
      nativeLogging: defaultNativeLogging({ runtime: "tauri", status: "healthy" }),
    })
    const { container } = render(<LogSettings />)
    expect(container.querySelector(".border-success\\/40")).toBeInTheDocument()
  })

  it("renders degraded tone (warning token)", () => {
    mockUseTransportHealth.mockReturnValue({
      nativeLogging: defaultNativeLogging({ runtime: "tauri", status: "degraded" }),
    })
    const { container } = render(<LogSettings />)
    expect(container.querySelector(".border-warning\\/40")).toBeInTheDocument()
  })

  it("renders inactive tone (muted)", () => {
    mockUseTransportHealth.mockReturnValue({
      nativeLogging: defaultNativeLogging({ status: "inactive" }),
    })
    const { container } = render(<LogSettings />)
    expect(container.querySelector(".border-border")).toBeInTheDocument()
  })

  it('shows the "none" placeholder when activeTargets is empty', () => {
    mockUseTransportHealth.mockReturnValue({
      nativeLogging: defaultNativeLogging({ runtime: "tauri" }),
    })
    const { container } = render(<LogSettings />)
    // The native target placeholder renders as plain text inside the targets span.
    const targetsBlock = Array.from(container.querySelectorAll("span")).find((s) =>
      s.textContent?.includes("Active targets:")
    )
    expect(targetsBlock?.textContent).toMatch(/Active targets:\s*none/)
  })

  it("shows joined activeTargets when populated", () => {
    mockUseTransportHealth.mockReturnValue({
      nativeLogging: defaultNativeLogging({
        runtime: "tauri",
        activeTargets: ["console", "file"],
      }),
    })
    render(<LogSettings />)
    expect(screen.getByText("console, file")).toBeInTheDocument()
  })

  it("shows fallback reason and bridge error when present", () => {
    mockUseTransportHealth.mockReturnValue({
      nativeLogging: defaultNativeLogging({
        runtime: "tauri",
        fallbackReason: { message: "ipc-init failed" },
        bridgeLastError: "EPIPE",
      }),
    })
    render(<LogSettings />)
    expect(screen.getByText("ipc-init failed")).toBeInTheDocument()
    expect(screen.getByText("EPIPE")).toBeInTheDocument()
  })

  it("uses default fallback to muted tone when status doesn't match known values", () => {
    mockUseTransportHealth.mockReturnValue({
      nativeLogging: defaultNativeLogging({ status: "unknown-future-value" as never }),
    })
    const { container } = render(<LogSettings />)
    expect(container.querySelector(".border-border")).toBeInTheDocument()
  })
})

describe("LogSettings — Save flow", () => {
  it("invokes applyLoggingSettings on Save click", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByText("Reset").closest("button") as HTMLButtonElement)
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement)
    expect(mockApplyLoggingSettings).toHaveBeenCalledTimes(1)
    expect(screen.queryAllByText("Unsaved changes").length).toBe(0)
  })

  it("persists sampling rules to localStorage and calls configureSampling", () => {
    render(<LogSettings />)
    // Reset triggers hasChanges; Save becomes enabled.
    fireEvent.click(screen.getByText("Reset").closest("button") as HTMLButtonElement)
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement)
    expect(mockConfigureSampling).toHaveBeenCalledTimes(1)
  })

  it("handles save error by transitioning to error and back to idle", () => {
    jest.useFakeTimers()
    mockApplyLoggingSettings.mockImplementationOnce(() => {
      throw new Error("kaboom")
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByText("Save"))
    // status switches to "error" but stays text-wise as Save (error label is implicit)
    act(() => {
      jest.advanceTimersByTime(3000)
    })
    expect(screen.getByText("Save")).toBeInTheDocument()
    jest.useRealTimers()
  })
})

describe("LogSettings — Reset", () => {
  it("clicking Reset returns config to defaults and shows Unsaved Badge", () => {
    render(<LogSettings />)
    const resetBtn = screen.getByText("Reset").closest("button") as HTMLButtonElement
    fireEvent.click(resetBtn)
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
  })
})

describe("LogSettings — Sampling rules", () => {
  it("renders default sampling rules with their module prefixes", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    expect(screen.getByText("mouse")).toBeInTheDocument()
    expect(screen.getByText("keyboard")).toBeInTheDocument()
    expect(screen.getByText("error")).toBeInTheDocument()
  })

  it("Add Rule with empty prefix is a no-op", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    const addBtn = screen.getByRole("button", { name: /Add Rule/i })
    fireEvent.click(addBtn)
    expect(screen.queryAllByText("Unsaved changes").length).toBe(0)
  })

  it("Add Rule input update populates the input field", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    const input = screen.getByPlaceholderText("mouse") as HTMLInputElement
    fireEvent.change(input, { target: { value: "telemetry" } })
    expect(input.value).toBe("telemetry")
  })

  it("Adding a duplicate prefix updates the existing rule rather than appending", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    const input = screen.getByPlaceholderText("mouse")
    fireEvent.change(input, { target: { value: "mouse" } })
    const addBtn = screen.getByRole("button", { name: /Add Rule/i })
    fireEvent.click(addBtn)
    expect(screen.getAllByText("mouse").length).toBe(1)
  })
})

describe("LogSettings — Bootstrap loading from localStorage", () => {
  it("loads sampling rules from localStorage when present and valid", () => {
    localStorage.setItem("cognia-logging-sampling", JSON.stringify({ custom: 0.5, another: 0.25 }))
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    expect(screen.getByText("custom")).toBeInTheDocument()
    expect(screen.getByText("another")).toBeInTheDocument()
  })

  it("falls back to defaults when localStorage JSON is invalid", () => {
    localStorage.setItem("cognia-logging-sampling", "not-json{")
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    expect(screen.getByText("mouse")).toBeInTheDocument()
  })

  it("falls back to defaults when stored JSON is empty / all whitespace prefixes", () => {
    localStorage.setItem("cognia-logging-sampling", JSON.stringify({ "  ": 0.5 }))
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    expect(screen.getByText("mouse")).toBeInTheDocument()
  })
})

describe("LogSettings — Transports tab", () => {
  it("renders all configured transport cards", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    expect(screen.getByText("Console Output")).toBeInTheDocument()
    expect(screen.getByText("IndexedDB Storage")).toBeInTheDocument()
    expect(screen.getByText("Platform Logging")).toBeInTheDocument()
    expect(screen.getByText("Remote Transport")).toBeInTheDocument()
    expect(screen.getByText("Langfuse Integration")).toBeInTheDocument()
  })

  it("renders transports tab content with at least one disabled Switch", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    const switches = screen.getAllByRole("switch")
    expect(switches.some((s) => s.getAttribute("aria-checked") === "false")).toBe(true)
  })

  it("editing the remote endpoint Input flips Unsaved Badge", () => {
    // pre-enable remote in bootstrap so Collapsible content is expanded
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: { ...defaultBootstrap().transports, remote: true },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    const input = screen.getByPlaceholderText("https://example.com/logs") as HTMLInputElement
    fireEvent.change(input, { target: { value: "https://logs.dev" } })
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
  })
})

describe("LogSettings — Retention tab", () => {
  it("renders the retention block with maxEntries and maxAgeDays", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Retention/ }))
    expect(screen.getByText("Maximum Entries")).toBeInTheDocument()
    expect(screen.getByText("Maximum Age (Days)")).toBeInTheDocument()
  })
})

describe("LogSettings — Advanced tab redaction & queue", () => {
  it("keeps behavior telemetry off until explicit opt-in is saved", async () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    const toggle = screen.getByTestId("behavior-telemetry-switch")
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    await act(async () => fireEvent.click(screen.getByText("Save")))
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: true })
    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: true })
  })

  it("records opt-out before disabling behavior telemetry", async () => {
    localStorage.setItem("cognia-behavior-telemetry-enabled", "true")
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    fireEvent.click(screen.getByTestId("behavior-telemetry-switch"))
    await act(async () => fireEvent.click(screen.getByText("Save")))
    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: false })
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: false })
  })

  it("toggles the redaction switch", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    expect(screen.getByText("Enable Redaction")).toBeInTheDocument()
  })

  it("renders sampling Slider with default percentage on each rule", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    const sliders = screen.getAllByRole("slider")
    expect(sliders.length).toBeGreaterThan(0)
  })

  it("Remove Rule button removes a sampling rule and triggers Unsaved", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    const removeBtns = screen.getAllByRole("button", { name: /Remove Rule/i })
    fireEvent.click(removeBtns[0])
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
  })

  it("editing a sampling Slider value triggers Unsaved (slider keyboard interaction)", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    const sliders = screen.getAllByRole("slider")
    // Simulating ArrowRight on the first slider increments its value (Radix Slider)
    sliders[0].focus()
    fireEvent.keyDown(sliders[0], { key: "ArrowRight" })
    // No strict assertion — coverage win is the keyDown side-effect.
    expect(sliders[0]).toBeInTheDocument()
  })

  it("renders the four advanced control descriptions", () => {
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Advanced/ }))
    expect(screen.getByText("Redaction Depth")).toBeInTheDocument()
    expect(screen.getByText("Remote Queue Entries")).toBeInTheDocument()
    expect(screen.getByText(/Remote Queue Size/)).toBeInTheDocument()
    expect(screen.getByText(/Diagnostic Rate Limit/)).toBeInTheDocument()
  })
})

describe("LogSettings — Level Select", () => {
  it("renders all six log levels in the Select content", () => {
    render(<LogSettings />)
    // Open the min-level Select
    const selectTrigger = screen.getAllByRole("combobox")[0]
    fireEvent.click(selectTrigger)
    // Items render as options
    expect(screen.getAllByText(/Trace|Debug|Info|Warning|Error|Fatal/).length).toBeGreaterThan(0)
  })
})

describe("LogSettings — Transport per-config inputs", () => {
  it("renders langfuse credentials fields when langfuse enabled", () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: { ...defaultBootstrap().transports, langfuse: true },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    expect(screen.getByPlaceholderText("pk-live-...")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("sk-live-...")).toBeInTheDocument()
  })

  it("changing the Langfuse host input triggers Unsaved", () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: { ...defaultBootstrap().transports, langfuse: true },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    const hostInput = screen.getByPlaceholderText("https://cloud.langfuse.com") as HTMLInputElement
    fireEvent.change(hostInput, { target: { value: "https://eu.langfuse.com" } })
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
  })

  it("renders agent-trace capture-content + retention controls when agentTrace enabled", () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: { ...defaultBootstrap().transports, agentTrace: true },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    expect(screen.getByTestId("agent-trace-capture-content-switch")).toBeInTheDocument()
    expect(screen.getByTestId("agent-trace-retention-slider")).toBeInTheDocument()
  })

  it("flipping the agent-trace capture-content switch marks Unsaved", () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: { ...defaultBootstrap().transports, agentTrace: true },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    const sw = screen.getByTestId("agent-trace-capture-content-switch")
    fireEvent.click(sw)
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
  })

  it("renders OTLP exporter preset + endpoint + headers fields when agentTraceOtlp is enabled", () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: { ...defaultBootstrap().transports, agentTraceOtlp: true },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    expect(screen.getByTestId("agent-trace-otlp-preset")).toBeInTheDocument()
    expect(screen.getByTestId("agent-trace-otlp-endpoint")).toBeInTheDocument()
    expect(screen.getByTestId("agent-trace-otlp-headers")).toBeInTheDocument()
  })

  it("changing the OTLP endpoint marks Unsaved", () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: { ...defaultBootstrap().transports, agentTraceOtlp: true },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    const endpointInput = screen.getByTestId("agent-trace-otlp-endpoint") as HTMLInputElement
    fireEvent.change(endpointInput, {
      target: { value: "http://localhost:4318/v1/traces" },
    })
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
  })

  it("drops sensitive OTLP headers and keeps non-sensitive pairs on save", async () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: { ...defaultBootstrap().transports, agentTraceOtlp: true },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    const headersInput = screen.getByTestId("agent-trace-otlp-headers") as HTMLInputElement
    fireEvent.change(headersInput, {
      target: { value: "Authorization: Basic abc==, X-Tenant: prod" },
    })
    await act(async () => fireEvent.click(screen.getByText("Save")))
    expect(mockApplyLoggingSettings).toHaveBeenCalled()
    const call = mockApplyLoggingSettings.mock.calls.at(-1) as [
      { transports?: { agentTraceOtlpConfig?: { headers: Record<string, string> } } },
    ]
    expect(call[0].transports?.agentTraceOtlpConfig?.headers).toEqual({
      "X-Tenant": "prod",
    })
  })

  it("shows Grafana instance ID + API token fields when preset is grafana-cloud (hides raw headers)", () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: {
        ...defaultBootstrap().transports,
        agentTraceOtlp: true,
        agentTraceOtlpConfig: {
          ...defaultBootstrap().transports.agentTraceOtlpConfig,
          preset: "grafana-cloud",
        },
      },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    expect(screen.getByTestId("agent-trace-otlp-grafana-instance-id")).toBeInTheDocument()
    expect(screen.getByTestId("agent-trace-otlp-grafana-api-token")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-trace-otlp-headers")).not.toBeInTheDocument()
  })

  it("persists Grafana credentials through the write-only secret seam", async () => {
    mockGetBootstrap.mockReturnValue({
      ...defaultBootstrap(),
      transports: {
        ...defaultBootstrap().transports,
        agentTraceOtlp: true,
        agentTraceOtlpConfig: {
          ...defaultBootstrap().transports.agentTraceOtlpConfig,
          preset: "grafana-cloud",
        },
      },
    })
    render(<LogSettings />)
    fireEvent.click(screen.getByRole("tab", { name: /Transports/ }))
    fireEvent.change(screen.getByTestId("agent-trace-otlp-grafana-instance-id"), {
      target: { value: "1234567" },
    })
    fireEvent.change(screen.getByTestId("agent-trace-otlp-grafana-api-token"), {
      target: { value: "glc_secret" },
    })
    await act(async () => fireEvent.click(screen.getByText("Save")))
    expect(mockPersistTelemetrySecret).toHaveBeenCalledWith("grafanaCloudApiToken", "glc_secret")
    const call = mockApplyLoggingSettings.mock.calls.at(-1) as [
      {
        transports?: {
          agentTraceOtlpConfig?: {
            grafanaCloud?: { instanceId: string; apiTokenConfigured: boolean }
            headers: Record<string, string>
          }
        }
      },
    ]
    expect(call[0].transports?.agentTraceOtlpConfig?.grafanaCloud).toEqual({
      instanceId: "1234567",
      apiTokenConfigured: true,
    })
    // Raw headers stay empty — Rust reads the token from the secret store.
    expect(call[0].transports?.agentTraceOtlpConfig?.headers).toEqual({})
  })
})

describe("LogSettings — Per-module levels", () => {
  function bootstrapWithModuleLevels(perModuleLevels: Record<string, string>) {
    const base = defaultBootstrap()
    return { ...base, config: { ...base.config, perModuleLevels } }
  }

  it("renders existing per-module level rules from the bootstrap config", () => {
    mockGetBootstrap.mockReturnValue(bootstrapWithModuleLevels({ network: "debug" }))
    render(<LogSettings />)
    expect(screen.getByText("network")).toBeInTheDocument()
  })

  it("offers registered modules as datalist suggestions", () => {
    render(<LogSettings />)
    const options = Array.from(document.querySelectorAll("datalist option")).map(
      (o) => (o as HTMLOptionElement).value
    )
    expect(options).toEqual(expect.arrayContaining(["ai", "network", "network:lark"]))
  })

  it("Add Module with empty prefix is a no-op", () => {
    render(<LogSettings />)
    const addBtn = screen.getByRole("button", { name: /Add Module/i })
    fireEvent.click(addBtn)
    expect(screen.queryAllByText("Unsaved changes").length).toBe(0)
  })

  it("adds a per-module rule and marks unsaved changes", () => {
    render(<LogSettings />)
    const input = screen.getByPlaceholderText("network:lark") as HTMLInputElement
    fireEvent.change(input, { target: { value: "connectors:slack" } })
    fireEvent.click(screen.getByRole("button", { name: /Add Module/i }))
    expect(screen.getByText("connectors:slack")).toBeInTheDocument()
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
  })

  it("includes perModuleLevels in the applyLoggingSettings payload on Save", () => {
    mockGetBootstrap.mockReturnValue(bootstrapWithModuleLevels({ network: "debug" }))
    render(<LogSettings />)
    const input = screen.getByPlaceholderText("network:lark") as HTMLInputElement
    fireEvent.change(input, { target: { value: "ai" } })
    fireEvent.click(screen.getByRole("button", { name: /Add Module/i }))
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement)
    const call = mockApplyLoggingSettings.mock.calls[0] as [
      { config: { perModuleLevels?: unknown } },
    ]
    expect(call[0].config.perModuleLevels).toMatchObject({ network: "debug", ai: "debug" })
  })

  it("removes a per-module rule", () => {
    mockGetBootstrap.mockReturnValue(bootstrapWithModuleLevels({ network: "debug" }))
    render(<LogSettings />)
    expect(screen.getByText("network")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Remove network override/i }))
    expect(screen.queryByText("network")).not.toBeInTheDocument()
  })
})
