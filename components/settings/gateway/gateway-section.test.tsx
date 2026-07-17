import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GatewaySection } from "./gateway-section"
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig, type GatewayStatus } from "@/types/gateway"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

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
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    // fireEvent.change sets the controlled number input in one shot — clear+type
    // fights the per-keystroke clamp on a controlled <input type=number>.
    fireEvent.change(screen.getByLabelText("port"), { target: { value: "50001" } })
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

  it("persists a request-timeout change", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText("requestTimeout"), { target: { value: "0" } })
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ requestTimeoutSecs: 0 }))
  })

  it("persists a per-gateway-key concurrency cap", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText("maxConcurrentPerKey"), { target: { value: "4" } })
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentPerKey: 4 }))
  })

  it("persists a rate-limit cooldown fallback change", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText("cooldownFallback"), { target: { value: "0" } })
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ cooldownFallbackSecs: 0 }))
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
