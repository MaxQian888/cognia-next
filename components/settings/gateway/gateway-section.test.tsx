import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GatewaySection } from "./gateway-section"
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig, type GatewayStatus } from "@/types/gateway"

// Echo the interpolation values too — otherwise a test that means to assert an
// interpolated value (e.g. a cooldown's recovery time) silently asserts only
// the key and passes no matter what was interpolated.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

// Child cards are covered by their own tests — stub them here.
jest.mock("./gateway-keys-card", () => ({
  GatewayKeysCard: () => <div data-testid="keys-card" />,
}))
jest.mock("./gateway-log-viewer", () => ({
  GatewayLogViewer: () => <div data-testid="log-viewer" />,
}))

let tauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

const mockGetConfig = jest.fn()
const mockGetStatus = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockUpdate = jest.fn()
const mockListCooldowns = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayGetConfig: () => mockGetConfig(),
  gatewayGetStatus: () => mockGetStatus(),
  gatewayStart: () => mockStart(),
  gatewayStop: () => mockStop(),
  gatewayUpdateConfig: (...a: unknown[]) => mockUpdate(...a),
  gatewayListCooldowns: () => mockListCooldowns(),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const status = (over: Partial<GatewayStatus> = {}): GatewayStatus => ({
  running: false,
  boundPort: null,
  hasToken: true,
  bindInterface: "loopback",
  callsTotal: 0,
  lastCallAt: null,
  snapshotGeneratedAtMs: null,
  snapshotProviderCount: 0,
  snapshotAliasCount: 0,
  ...over,
})

const config = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  ...DEFAULT_GATEWAY_CONFIG,
  ...over,
})

beforeEach(() => {
  tauri = true
  mockGetConfig.mockReset().mockResolvedValue(config())
  mockGetStatus.mockReset().mockResolvedValue(status())
  mockStart.mockReset().mockResolvedValue(undefined)
  mockStop.mockReset().mockResolvedValue(undefined)
  mockUpdate.mockReset().mockResolvedValue(undefined)
  mockListCooldowns.mockReset().mockResolvedValue([])
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
})

describe("GatewaySection", () => {
  it("shows the desktop-only notice outside Tauri", () => {
    tauri = false
    render(<GatewaySection />)
    expect(screen.getByText("desktopOnlyNotice")).toBeInTheDocument()
  })

  it("hydrates config + status and renders the base-URL snippets", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    expect(mockGetStatus).toHaveBeenCalled()
    expect(screen.getByText(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:47823/)).toBeInTheDocument()
    expect(screen.getByText(/OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:47823\/v1/)).toBeInTheDocument()
    expect(screen.getByTestId("keys-card")).toBeInTheDocument()
    expect(screen.getByTestId("log-viewer")).toBeInTheDocument()
  })

  it("starts the gateway when the enable switch is toggled on", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled())
    await user.click(screen.getByRole("switch", { name: "enabled" }))
    expect(mockStart).toHaveBeenCalled()
  })

  it("disables the enable switch without a usable key", async () => {
    mockGetStatus.mockResolvedValue(status({ hasToken: false }))
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled())
    expect(screen.getByRole("switch", { name: "enabled" })).toBeDisabled()
    expect(screen.getAllByText("requiresKey").length).toBeGreaterThan(0)
  })

  it("persists a port change", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    // Real clear+type now works: the field no longer clamps per keystroke, so
    // an empty draft and a below-`min` prefix both survive until commit.
    const input = screen.getByLabelText("port")
    await user.clear(input)
    await user.type(input, "50001")
    await user.tab()
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ port: 50001 }))
  })

  it("shows the LAN warning and switches the bind interface", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    // loopback by default → no warning
    expect(screen.queryByText("lanWarning")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "bindLan" }))
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ bindInterface: "lan" }))
    expect(await screen.findByText("lanWarning")).toBeInTheDocument()
  })

  it("adds a retry status code chip", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("retryStatusCodes")
    await user.type(input, "418{Enter}")
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ retryStatusCodes: expect.arrayContaining([418]) })
    )
  })

  it("toggles hide-raw-provider-models exposure", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    await user.click(screen.getByRole("switch", { name: "hideRawModels" }))
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ hideRawProviderModels: true })
    )
  })

  // Number fields commit on blur / Enter, not per keystroke — clamping every
  // keystroke made them unusable (see the port regression below).
  it("persists a request-timeout change", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("requestTimeout")
    fireEvent.change(input, { target: { value: "0" } })
    fireEvent.blur(input)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ requestTimeoutSecs: 0 }))
  })

  it("persists a per-gateway-key concurrency cap", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("maxConcurrentPerKey")
    fireEvent.change(input, { target: { value: "4" } })
    fireEvent.blur(input)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentPerKey: 4 }))
  })

  it("persists a rate-limit cooldown fallback change", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("cooldownFallback")
    fireEvent.change(input, { target: { value: "0" } })
    fireEvent.blur(input)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ cooldownFallbackSecs: 0 }))
  })

  it("lets a port below the clamp floor be typed out before committing", async () => {
    // Regression: clamping per keystroke turned the first digit of "8080" into
    // 1024 (the `min`), so most ports were literally unreachable by typing.
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("port")
    fireEvent.change(input, { target: { value: "8" } })
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(input).toHaveValue(8)

    fireEvent.change(input, { target: { value: "8080" } })
    fireEvent.blur(input)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ port: 8080 }))
  })

  it("clamps an out-of-range port only once the edit is committed", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("port")
    fireEvent.change(input, { target: { value: "70000" } })
    // The "only once committed" half of the claim — the old per-keystroke
    // implementation clamped to the same 65535 right here.
    expect(mockUpdate).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ port: 65535 }))
  })

  it("keeps a chip typed but never Enter-ed instead of dropping it on blur", async () => {
    // Regression: the draft lived in a ref and was discarded on blur, so a
    // typed-but-uncommitted allowlist entry vanished with no feedback.
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("allowlist")
    fireEvent.change(input, { target: { value: "10.0.0.0/8" } })
    fireEvent.blur(input)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ allowlist: expect.arrayContaining(["10.0.0.0/8"]) })
    )
  })

  it("stops the listener when the switch is toggled off", async () => {
    mockGetStatus.mockResolvedValue(status({ running: true, boundPort: 47823 }))
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(screen.getByRole("switch", { name: "enabled" })).toBeChecked())

    await user.click(screen.getByRole("switch", { name: "enabled" }))
    expect(mockStop).toHaveBeenCalled()
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("surfaces a start failure instead of leaving the switch half-flipped", async () => {
    const { toast } = jest.requireMock("sonner")
    mockStart.mockRejectedValue(new Error("address already in use"))
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled())

    await user.click(screen.getByRole("switch", { name: "enabled" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("address already in use"))
    // The switch mirrors real status, so a failed start leaves it off.
    expect(screen.getByRole("switch", { name: "enabled" })).not.toBeChecked()
  })

  it("copies a client base-URL snippet", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    // `navigator.clipboard` is a read-only accessor in jsdom, and
    // `userEvent.setup()` installs its own stub — so define it directly and
    // drive the click with fireEvent.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())

    fireEvent.click(screen.getAllByRole("button", { name: "copy" })[0])
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining(`http://127.0.0.1:${DEFAULT_GATEWAY_CONFIG.port}`)
      )
    )
  })

  it("commits a number field on Enter without waiting for blur", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("maxRetries")
    fireEvent.change(input, { target: { value: "3" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 3 }))
  })

  // Every remaining control, walked once. Beyond coverage this pins the
  // label → config-key wiring, which is the obvious copy-paste hazard in a
  // panel with seventeen near-identical rows.
  it.each([
    ["rateLimit", "120", { rateLimitPerMin: 120 }],
    ["connectTimeout", "15", { connectTimeoutSecs: 15 }],
    ["maxConcurrentPerUpstreamKey", "6", { maxConcurrentPerUpstreamKey: 6 }],
    ["concurrencyWait", "2500", { concurrencyWaitMs: 2500 }],
    ["overloadCooldown", "90", { overloadCooldownSecs: 90 }],
  ])("persists the %s number field", async (label, typed, expected) => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: typed } })
    fireEvent.blur(input)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining(expected))
  })

  it.each([
    ["exposedModels", "gpt-4o", "exposedModels"],
    ["disableKeywords", "billing_hard_limit_reached", "disableKeywords"],
    ["strippedFields", "metadata.user_id", "strippedRequestFields"],
    ["fieldStripAllow", "openai:store", "fieldStripAllow"],
  ])("appends to the %s chip list", async (label, typed, configKey) => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: typed } })
    fireEvent.blur(input)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ [configKey]: expect.arrayContaining([typed]) })
    )
  })

  it("commits a chip from the add button's own handler", async () => {
    // The add button commits on mousedown, not click: mousedown blurs the
    // input, the blur commits and clears the draft, and the button then renders
    // disabled — so an onClick handler could never fire. Driving mousedown ALONE
    // isolates the button's own path; an onClick-based button fails this
    // outright, and no blur is involved to mask the difference.
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("exposedModels")
    fireEvent.change(input, { target: { value: "gpt-4o" } })
    fireEvent.mouseDown(screen.getByRole("button", { name: "add exposedModels" }))

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ exposedModels: ["gpt-4o"] }))
  })

  it("does not double-add when the add button's mousedown is followed by a blur", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    await user.type(screen.getByLabelText("exposedModels"), "gpt-4o")
    // Full pointer sequence: mousedown commits, the ensuing blur sees an empty
    // draft and must no-op rather than committing a second time.
    await user.click(screen.getByRole("button", { name: "add exposedModels" }))
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it("removes a chip", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    // The default allowlist ships one entry.
    await user.click(screen.getByRole("button", { name: "remove 127.0.0.1/32" }))
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ allowlist: [] }))
  })

  it("surfaces a config-write failure", async () => {
    const { toast } = jest.requireMock("sonner")
    mockUpdate.mockRejectedValue(new Error("disk full"))
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    const input = screen.getByLabelText("maxRetries")
    fireEvent.change(input, { target: { value: "2" } })
    fireEvent.blur(input)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("disk full"))
  })

  it("renders a temporary cooldown with its recovery time", async () => {
    const untilMs = Date.UTC(2026, 6, 21, 10, 32, 11)
    mockListCooldowns.mockResolvedValue([
      {
        providerId: "openai",
        keyHint: "…9999",
        untilMs,
        permanent: false,
        reason: "rate limited",
      },
    ])
    render(<GatewaySection />)
    // Assert the interpolated clock, not just the key — the row is useless if
    // it renders "Cooling until {time}" with the wrong field.
    expect(
      await screen.findByText(`cooldownsCoolingUntil:${new Date(untilMs).toLocaleTimeString()}`)
    ).toBeInTheDocument()
    expect(screen.queryByText("cooldownsPermanent")).not.toBeInTheDocument()
  })

  it("lists parked upstream accounts and refreshes on demand", async () => {
    const user = userEvent.setup()
    mockListCooldowns
      .mockResolvedValueOnce([]) // initial mount → empty
      .mockResolvedValueOnce([
        { providerId: "openai", keyHint: "…1234", untilMs: 0, permanent: true, reason: "quota" },
      ])
    render(<GatewaySection />)
    await waitFor(() => expect(mockListCooldowns).toHaveBeenCalled())
    expect(screen.getByText("cooldownsEmpty")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "cooldownsRefresh" }))
    expect(await screen.findByText(/openai · …1234/)).toBeInTheDocument()
    expect(screen.getByText("cooldownsPermanent")).toBeInTheDocument()
  })
})
