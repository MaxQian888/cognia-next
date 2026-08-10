import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GatewaySection } from "./gateway-section"
import { isTauri } from "@/lib/tauri"
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig, type GatewayStatus } from "@/types/gateway"

// Echo the interpolation values too — otherwise a test that means to assert an
// interpolated value silently asserts only the key and passes regardless.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

let searchString = ""
const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(searchString),
}))

// Every panel has its own test; the shell only needs to prove the right one
// renders.
// The overview stub re-exposes the shell's own callbacks so the start/stop and
// config-write paths stay covered without dragging the real panel in.
jest.mock("./panels/overview-panel", () => ({
  GatewayOverviewPanel: ({
    ctx,
    onToggleEnabled,
  }: {
    ctx: { config: { port: number }; persist: (p: Record<string, unknown>) => void }
    onToggleEnabled: (next: boolean) => void
  }) => (
    <div data-testid="panel-overview">
      <button type="button" data-testid="stub-start" onClick={() => onToggleEnabled(true)}>
        start
      </button>
      <button type="button" data-testid="stub-stop" onClick={() => onToggleEnabled(false)}>
        stop
      </button>
      <button type="button" data-testid="stub-persist" onClick={() => ctx.persist({ port: 50001 })}>
        persist
      </button>
      <span data-testid="stub-port">{ctx.config.port}</span>
    </div>
  ),
}))
jest.mock("./panels/listener-panel", () => ({
  GatewayListenerPanel: () => <div data-testid="panel-listener" />,
}))
// The keys and logs panels are self-contained, so the section renders them
// directly.
jest.mock("./gateway-keys-card", () => ({
  GatewayKeysCard: () => <div data-testid="panel-keys" />,
}))
jest.mock("./panels/reliability-panel", () => ({
  GatewayReliabilityPanel: () => <div data-testid="panel-reliability" />,
}))
jest.mock("./panels/upstream-panel", () => ({
  GatewayUpstreamPanel: () => <div data-testid="panel-upstream" />,
}))
jest.mock("./panels/exposure-panel", () => ({
  GatewayExposurePanel: () => <div data-testid="panel-exposure" />,
}))
jest.mock("./gateway-log-viewer", () => ({
  GatewayLogViewer: () => <div data-testid="panel-logs" />,
}))
jest.mock("./panels/route-tickets-panel", () => ({
  GatewayRouteTicketsPanel: () => <div data-testid="panel-tickets" />,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
const mockIsTauri = jest.mocked(isTauri)

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
  mockIsTauri.mockReturnValue(true)
  searchString = ""
  replace.mockReset()
  mockGetConfig.mockReset().mockResolvedValue(config())
  mockGetStatus.mockReset().mockResolvedValue(status())
  mockStart.mockReset().mockResolvedValue(undefined)
  mockStop.mockReset().mockResolvedValue(undefined)
  mockUpdate.mockReset().mockResolvedValue(undefined)
  mockListCooldowns.mockReset().mockResolvedValue([])
})

describe("GatewaySection", () => {
  it("shows the desktop-only notice outside Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    render(<GatewaySection />)

    expect(screen.getByText("desktopOnlyNotice")).toBeInTheDocument()
    expect(screen.queryByTestId("gateway-section")).not.toBeInTheDocument()
  })

  it("does no IPC outside Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    render(<GatewaySection />)

    expect(mockGetConfig).not.toHaveBeenCalled()
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it("hydrates config, status and cooldowns on mount", async () => {
    render(<GatewaySection />)

    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    expect(mockGetStatus).toHaveBeenCalled()
    expect(mockListCooldowns).toHaveBeenCalled()
  })

  it("lands on the overview panel by default", async () => {
    render(<GatewaySection />)
    expect(await screen.findByTestId("panel-overview")).toBeInTheDocument()
  })

  it.each([
    ["listener", "panel-listener"],
    ["keys", "panel-keys"],
    ["reliability", "panel-reliability"],
    ["upstream", "panel-upstream"],
    ["exposure", "panel-exposure"],
    ["logs", "panel-logs"],
    ["tickets", "panel-tickets"],
  ])("deep-links straight to the %s panel", async (panel, testId) => {
    searchString = `gatewayPanel=${panel}`
    render(<GatewaySection />)

    expect(await screen.findByTestId(testId)).toBeInTheDocument()
  })

  it("falls back to the overview for an unknown deep link", async () => {
    searchString = "gatewayPanel=nonsense"
    render(<GatewaySection />)

    expect(await screen.findByTestId("panel-overview")).toBeInTheDocument()
  })

  it("writes the selected panel into the URL without scrolling", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await screen.findByTestId("panel-overview")

    await user.click(screen.getByTestId("gateway-nav-item-upstream"))

    expect(replace).toHaveBeenCalledWith("?gatewayPanel=upstream", { scroll: false })
  })

  it("preserves unrelated query params when switching panels", async () => {
    // The settings shell keeps its own `?section=` param in the same URL.
    searchString = "section=gateway"
    const user = userEvent.setup()
    render(<GatewaySection />)
    await screen.findByTestId("panel-overview")

    await user.click(screen.getByTestId("gateway-nav-item-logs"))

    expect(replace).toHaveBeenCalledWith(expect.stringContaining("section=gateway"), {
      scroll: false,
    })
  })

  it("badges the keys panel when no usable key exists", async () => {
    mockGetStatus.mockResolvedValue(status({ hasToken: false }))
    render(<GatewaySection />)

    expect(await screen.findByTestId("gateway-nav-badge-keys")).toHaveTextContent("!")
  })

  it("badges the upstream panel with the parked-key count from any panel", async () => {
    mockListCooldowns.mockResolvedValue([
      { providerId: "openai", keyHint: "…1", untilMs: 0, permanent: false, reason: "429" },
      { providerId: "groq", keyHint: "…2", untilMs: 0, permanent: false, reason: "429" },
    ])
    render(<GatewaySection />)

    expect(await screen.findByTestId("gateway-nav-badge-upstream")).toHaveTextContent("2")
  })

  it("has no cooldown badge when nothing is parked", async () => {
    render(<GatewaySection />)
    await screen.findByTestId("panel-overview")

    expect(screen.queryByTestId("gateway-nav-badge-upstream")).not.toBeInTheDocument()
  })

  it("renders the mobile nav trigger for the sub-md layout", async () => {
    render(<GatewaySection />)
    expect(await screen.findByTestId("gateway-mobile-nav-trigger")).toBeInTheDocument()
  })

  describe("shared callbacks handed to the panels", () => {
    it("starts the listener and re-reads status", async () => {
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")
      mockGetStatus.mockClear()

      await user.click(screen.getByTestId("stub-start"))

      expect(mockStart).toHaveBeenCalled()
      await waitFor(() => expect(mockGetStatus).toHaveBeenCalled())
    })

    it("stops the listener", async () => {
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-stop"))

      expect(mockStop).toHaveBeenCalled()
      expect(mockStart).not.toHaveBeenCalled()
    })

    it("refuses to start without a usable key", async () => {
      const { toast } = jest.requireMock("sonner")
      mockGetStatus.mockResolvedValue(status({ hasToken: false }))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-start"))

      expect(mockStart).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith("requiresKey")
    })

    it("surfaces a start failure rather than leaving the UI half-flipped", async () => {
      const { toast } = jest.requireMock("sonner")
      mockStart.mockRejectedValue(new Error("address already in use"))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-start"))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("address already in use"))
    })

    it("merges a patch into the full config before writing it", async () => {
      // Rust replaces the whole config document, so a partial write would reset
      // every field the panel did not touch.
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-persist"))

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 50001,
          rateLimitPerMin: DEFAULT_GATEWAY_CONFIG.rateLimitPerMin,
          retryStatusCodes: DEFAULT_GATEWAY_CONFIG.retryStatusCodes,
        })
      )
    })

    it("merges into the LOADED config, not the defaults, while a poll is in flight", async () => {
      // The regression: `persist` read the current config out of a `setConfig`
      // updater. React only runs updaters eagerly when the fiber has no pending
      // lanes, and this component independently schedules the status and
      // cooldown polls — so with one in flight the read fell through to
      // `DEFAULT_GATEWAY_CONFIG` and a single toggle shipped every untouched
      // field back to its default.
      mockGetConfig.mockResolvedValue(
        config({ port: 9999, allowlist: ["10.0.0.0/8"], exposedModels: ["claude-opus-5"] })
      )
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")
      await waitFor(() => expect(screen.getByTestId("stub-port")).toHaveTextContent("9999"))

      await user.click(screen.getByTestId("stub-persist"))

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 50001,
          allowlist: ["10.0.0.0/8"],
          exposedModels: ["claude-opus-5"],
        })
      )
    })

    it("carries an earlier edit into the next write", async () => {
      // Two edits in a row must compose; the second used to start from the
      // defaults again and undo the first.
      mockGetConfig.mockResolvedValue(config({ allowlist: ["10.0.0.0/8"] }))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-persist"))
      await user.click(screen.getByTestId("stub-persist"))

      expect(mockUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ port: 50001, allowlist: ["10.0.0.0/8"] })
      )
    })

    it("reflects the persisted value back into the panels", async () => {
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-persist"))

      await waitFor(() => expect(screen.getByTestId("stub-port")).toHaveTextContent("50001"))
    })

    it("surfaces a config-write failure", async () => {
      const { toast } = jest.requireMock("sonner")
      mockUpdate.mockRejectedValue(new Error("disk full"))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-persist"))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("disk full"))
    })
  })
})
