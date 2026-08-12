import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GatewayOverviewPanel } from "./overview-panel"
import { DEFAULT_GATEWAY_CONFIG, type GatewayStatus } from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const mockProbe = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayProbeUpstream: (model: string) => mockProbe(model),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

// RollingNumber animates imperatively; render the settled value instead.
jest.mock("@/components/settings/subagents/motion/rolling-number", () => ({
  RollingNumber: ({ value }: { value: number }) => <span>{value}</span>,
}))

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

function setup(statusOver: GatewayStatus | null = status(), starting = false) {
  const persist = jest.fn().mockResolvedValue(undefined)
  const onToggleEnabled = jest.fn().mockResolvedValue(undefined)
  const onRefreshStatus = jest.fn().mockResolvedValue(undefined)
  render(
    <GatewayOverviewPanel
      ctx={{
        config: DEFAULT_GATEWAY_CONFIG,
        status: statusOver,
        persist,
        replace: jest.fn(),
        restartRequired: false,
      }}
      starting={starting}
      onToggleEnabled={onToggleEnabled}
      onRefreshStatus={onRefreshStatus}
    />
  )
  return { onToggleEnabled, onRefreshStatus }
}

beforeEach(() => {
  mockProbe.mockReset().mockResolvedValue([])
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
})

describe("GatewayOverviewPanel", () => {
  // These five fields were computed by Rust, serialized into GatewayStatus, and
  // rendered nowhere — they appeared only in a test fixture. Pinned so they
  // cannot quietly regress to that state.
  it("renders the durable call counters", () => {
    setup(status({ callsTotal: 42, lastCallAt: "2026-07-28T10:00:00.000Z" }))

    expect(screen.getByTestId("gateway-stat-calls")).toHaveTextContent("42")
    expect(screen.getByTestId("gateway-stat-last-call")).toHaveTextContent(
      new Date("2026-07-28T10:00:00.000Z").toLocaleTimeString()
    )
  })

  it("says so when no request has ever been served", () => {
    setup(status({ callsTotal: 0, lastCallAt: null }))
    expect(screen.getByTestId("gateway-stat-last-call")).toHaveTextContent("statNever")
  })

  it("renders the routing snapshot counts and its age", () => {
    const generated = Date.UTC(2026, 6, 28, 9, 30)
    setup(
      status({
        snapshotProviderCount: 3,
        snapshotAliasCount: 7,
        snapshotGeneratedAtMs: generated,
      })
    )

    expect(screen.getByTestId("gateway-stat-providers")).toHaveTextContent("3")
    expect(screen.getByTestId("gateway-stat-aliases")).toHaveTextContent("7")
    expect(screen.getByTestId("gateway-snapshot-age")).toHaveTextContent(
      `snapshotGeneratedAt:${new Date(generated).toLocaleString()}`
    )
  })

  it("distinguishes 'no snapshot yet' from a zero-count snapshot", () => {
    setup(status({ snapshotGeneratedAtMs: null }))
    expect(screen.getByTestId("gateway-snapshot-age")).toHaveTextContent("snapshotNone")
  })

  it("shows the local routing policy revision", () => {
    setup(
      status({
        localRoutingEnabled: true,
        routingPolicyRevision: "policy-42",
        routingStrategy: "least-busy",
      })
    )

    expect(screen.getByTestId("gateway-routing-authority")).toHaveTextContent(
      "localRoutingActive:policy-42"
    )
    expect(screen.getByTestId("gateway-auto-strategy")).toHaveTextContent("autoStrategy:least-busy")
  })

  it("warns when a custom strategy degrades to reliability", () => {
    setup(
      status({
        localRoutingEnabled: true,
        routingStrategy: "reliability",
        routingStrategyUnavailable: "plugin:private-selector",
      })
    )

    expect(screen.getByText("strategyUnavailable:plugin:private-selector")).toBeInTheDocument()
  })

  it("labels legacy routing and handles a missing policy revision", () => {
    const { rerender } = render(
      <GatewayOverviewPanel
        ctx={{
          config: DEFAULT_GATEWAY_CONFIG,
          status: status(),
          persist: jest.fn(),
          replace: jest.fn(),
          restartRequired: false,
        }}
        starting={false}
        onToggleEnabled={jest.fn()}
        onRefreshStatus={jest.fn()}
      />
    )
    expect(screen.getByTestId("gateway-routing-authority")).toHaveTextContent("localRoutingLegacy")

    rerender(
      <GatewayOverviewPanel
        ctx={{
          config: DEFAULT_GATEWAY_CONFIG,
          status: status({ localRoutingEnabled: true, routingPolicyRevision: null }),
          persist: jest.fn(),
          replace: jest.fn(),
          restartRequired: false,
        }}
        starting={false}
        onToggleEnabled={jest.fn()}
        onRefreshStatus={jest.fn()}
      />
    )
    expect(screen.getByTestId("gateway-routing-authority")).toHaveTextContent(
      "localRoutingActive:routingRevisionUnavailable"
    )
  })

  it("renders safely before status has hydrated", () => {
    // The shell passes `status: null` until the first IPC round-trip returns;
    // every counter must fall back rather than render "undefined".
    setup(null)

    expect(screen.getByTestId("gateway-stat-calls")).toHaveTextContent("0")
    expect(screen.getByTestId("gateway-stat-last-call")).toHaveTextContent("statNever")
    expect(screen.getByTestId("gateway-stat-providers")).toHaveTextContent("0")
    expect(screen.getByTestId("gateway-stat-aliases")).toHaveTextContent("0")
    expect(screen.getByTestId("gateway-snapshot-age")).toHaveTextContent("snapshotNone")
    // No status means no key confirmed, so the switch stays locked.
    expect(screen.getByRole("switch", { name: "enabled" })).toBeDisabled()
    // …and it falls back to the configured port for both read-only snippets.
    expect(screen.getByRole("textbox", { name: "anthropicSnippet" })).toHaveValue(
      "ANTHROPIC_BASE_URL=http://127.0.0.1:47823"
    )
    expect(screen.getByRole("textbox", { name: "openaiSnippet" })).toHaveValue(
      "OPENAI_BASE_URL=http://127.0.0.1:47823/v1"
    )
  })

  it("renders a probe row that reports no HTTP status at all", async () => {
    // A connect-level failure has `status: null` — the badge must say so rather
    // than render an empty pill.
    mockProbe.mockResolvedValue([
      {
        providerId: "openai",
        modelId: "gpt-4o",
        ok: false,
        status: null,
        latencyMs: 30,
        error: "connect error: timed out",
      },
    ])
    setup(status({ running: true }))

    fireEvent.change(screen.getByLabelText("selfCheckModel"), { target: { value: "fast" } })
    fireEvent.click(screen.getByTestId("gateway-probe-run"))

    expect(await screen.findByText("selfCheckNoStatus")).toBeInTheDocument()
    expect(screen.getByText(/connect error: timed out/)).toBeInTheDocument()
  })

  it("renders a clean probe result with no error lines", async () => {
    mockProbe.mockResolvedValue([
      {
        providerId: "openai",
        modelId: "gpt-4o",
        ok: true,
        status: 200,
        latencyMs: 12,
        error: null,
      },
    ])
    setup(status({ running: true }))

    fireEvent.change(screen.getByLabelText("selfCheckModel"), { target: { value: "fast" } })
    fireEvent.click(screen.getByTestId("gateway-probe-run"))

    await screen.findByTestId("gateway-probe-results")
    expect(screen.queryByTestId("gateway-probe-error")).not.toBeInTheDocument()
  })

  it("renders and copies the client base-URL snippets", async () => {
    const user = userEvent.setup()
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    setup()

    expect(screen.getByRole("textbox", { name: "anthropicSnippet" })).toHaveValue(
      "ANTHROPIC_BASE_URL=http://127.0.0.1:47823"
    )
    expect(screen.getByRole("textbox", { name: "openaiSnippet" })).toHaveValue(
      "OPENAI_BASE_URL=http://127.0.0.1:47823/v1"
    )

    await user.click(screen.getByRole("button", { name: "copy anthropicSnippet" }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:47823"))
    )
  })

  it("reports a client snippet copy failure", async () => {
    const user = userEvent.setup()
    const writeText = jest.fn().mockRejectedValueOnce(new Error("copy denied"))
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const { toast } = jest.requireMock("sonner")
    setup()

    await user.click(screen.getByRole("button", { name: "copy anthropicSnippet" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copy denied"))
  })

  it("uses the translated fallback for a non-Error snippet copy rejection", async () => {
    const user = userEvent.setup()
    const writeText = jest.fn().mockRejectedValueOnce({ reason: "denied" })
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const { toast } = jest.requireMock("sonner")
    setup()

    await user.click(screen.getByRole("button", { name: "copy anthropicSnippet" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"))
  })

  it("prefers the bound port over the configured one in the snippets", () => {
    setup(status({ running: true, boundPort: 50505 }))
    expect(screen.getByRole("textbox", { name: "anthropicSnippet" })).toHaveValue(
      "ANTHROPIC_BASE_URL=http://127.0.0.1:50505"
    )
  })

  it("toggles the listener and disables the switch without a key", () => {
    const { onToggleEnabled } = setup(status({ hasToken: true }))

    fireEvent.click(screen.getByRole("switch", { name: "enabled" }))
    expect(onToggleEnabled).toHaveBeenCalledWith(true)
  })

  it("disables the switch when no usable key exists", () => {
    setup(status({ hasToken: false }))

    expect(screen.getByRole("switch", { name: "enabled" })).toBeDisabled()
    expect(screen.getByText("requiresKey")).toBeInTheDocument()
  })

  it("shows a pending indicator and blocks the switch mid-flight", () => {
    // Without this a double-click queues a stop behind a start and the UI ends
    // up disagreeing with Rust.
    setup(status(), true)

    expect(screen.getByTestId("gateway-toggle-pending")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "enabled" })).toBeDisabled()
  })

  describe("upstream self-check", () => {
    it("is unavailable while the gateway is stopped", () => {
      setup(status({ running: false }))

      fireEvent.change(screen.getByLabelText("selfCheckModel"), { target: { value: "fast" } })
      expect(screen.getByTestId("gateway-probe-run")).toBeDisabled()
      expect(screen.getByText("selfCheckNeedsRunning")).toBeInTheDocument()
    })

    it("never probes on mount — every row is a billable upstream call", () => {
      setup(status({ running: true }))
      expect(mockProbe).not.toHaveBeenCalled()
    })

    it("probes the typed model and renders one row per candidate", async () => {
      mockProbe.mockResolvedValue([
        {
          providerId: "openai",
          modelId: "gpt-4o",
          ok: true,
          status: 200,
          latencyMs: 120,
          error: null,
        },
        {
          providerId: "groq",
          modelId: "llama-3.3-70b",
          ok: false,
          status: 429,
          latencyMs: 80,
          error: "rate limited",
        },
      ])
      const { onRefreshStatus } = setup(status({ running: true }))

      fireEvent.change(screen.getByLabelText("selfCheckModel"), { target: { value: "fast" } })
      fireEvent.click(screen.getByTestId("gateway-probe-run"))

      await waitFor(() => expect(screen.getByTestId("gateway-probe-results")).toBeInTheDocument())
      expect(mockProbe).toHaveBeenCalledWith("fast")
      expect(screen.getByText(/openai · gpt-4o/)).toBeInTheDocument()
      expect(screen.getByText(/groq · llama-3.3-70b/)).toBeInTheDocument()
      expect(screen.getByText(/rate limited/)).toBeInTheDocument()
      // A probe counts toward callsTotal, so status must be re-read.
      expect(onRefreshStatus).toHaveBeenCalled()
    })

    it("runs the probe on Enter without reaching for the button", async () => {
      mockProbe.mockResolvedValue([
        {
          providerId: "openai",
          modelId: "gpt-4o",
          ok: true,
          status: 200,
          latencyMs: 5,
          error: null,
        },
      ])
      setup(status({ running: true }))

      const input = screen.getByLabelText("selfCheckModel")
      fireEvent.change(input, { target: { value: "fast" } })
      fireEvent.keyDown(input, { key: "Enter" })

      await waitFor(() => expect(mockProbe).toHaveBeenCalledWith("fast"))
    })

    it("ignores Enter on an empty model box", () => {
      setup(status({ running: true }))

      fireEvent.keyDown(screen.getByLabelText("selfCheckModel"), { key: "Enter" })

      expect(mockProbe).not.toHaveBeenCalled()
    })

    it("surfaces a probe failure instead of rendering an empty result list", async () => {
      mockProbe.mockRejectedValue(new Error("no routing snapshot yet"))
      setup(status({ running: true }))

      fireEvent.change(screen.getByLabelText("selfCheckModel"), { target: { value: "fast" } })
      fireEvent.click(screen.getByTestId("gateway-probe-run"))

      expect(await screen.findByTestId("gateway-probe-error")).toHaveTextContent(
        "no routing snapshot yet"
      )
      expect(screen.queryByTestId("gateway-probe-results")).not.toBeInTheDocument()
    })
  })
})
