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
    ctx: {
      config: { port: number }
      status: GatewayStatus | null
      persist: (p: Partial<GatewayConfig>) => void
    }
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
      <button
        type="button"
        data-testid="stub-persist-bind"
        onClick={() => ctx.persist({ bindInterface: "lan" })}
      >
        persist bind
      </button>
      <button
        type="button"
        data-testid="stub-persist-allowlist"
        onClick={() => ctx.persist({ allowlist: ["10.0.0.0/8"] })}
      >
        persist allowlist
      </button>
      <span data-testid="stub-port">{ctx.config.port}</span>
      <span data-testid="stub-running">{String(ctx.status?.running)}</span>
    </div>
  ),
}))
jest.mock("./panels/listener-panel", () => ({
  GatewayListenerPanel: ({
    ctx,
    onRestarted,
  }: {
    ctx: { persist: (patch: Partial<GatewayConfig>) => Promise<void> }
    onRestarted: () => Promise<void>
  }) => (
    <div data-testid="panel-listener">
      <button
        type="button"
        data-testid="stub-listener-persist"
        onClick={() => void ctx.persist({ port: 50003 })}
      >
        persist listener
      </button>
      <button type="button" data-testid="stub-restarted" onClick={() => void onRestarted()}>
        restarted
      </button>
    </div>
  ),
}))
// The keys and logs panels are self-contained, so the section renders them
// directly.
jest.mock("./gateway-keys-card", () => ({
  GatewayKeysCard: ({ onChanged }: { onChanged: () => void }) => (
    <div data-testid="panel-keys">
      <button type="button" data-testid="stub-keys-changed" onClick={onChanged}>
        keys changed
      </button>
    </div>
  ),
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
jest.mock("./panels/custom-panel", () => ({
  GatewayCustomPanel: ({
    ctx,
  }: {
    ctx: {
      config: GatewayConfig
      status: GatewayStatus | null
      replace: (config: GatewayConfig) => Promise<void>
    }
  }) => (
    <div data-testid="panel-custom">
      <button
        type="button"
        data-testid="stub-replace"
        onClick={() => {
          void ctx.replace({ ...ctx.config, enabled: true, port: 50002 }).catch(() => {})
        }}
      >
        replace
      </button>
      <button
        type="button"
        data-testid="stub-replace-disabled"
        onClick={() => {
          void ctx.replace({ ...ctx.config, enabled: false }).catch(() => {})
        }}
      >
        replace disabled
      </button>
      <span data-testid="stub-running">{String(ctx.status?.running)}</span>
    </div>
  ),
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

  it("keeps the shell usable when background hydration endpoints fail", async () => {
    mockGetConfig.mockRejectedValue(new Error("config unavailable"))
    mockGetStatus.mockRejectedValue(new Error("status unavailable"))
    mockListCooldowns.mockRejectedValue(new Error("cooldowns unavailable"))

    render(<GatewaySection />)

    expect(await screen.findByTestId("panel-overview")).toBeInTheDocument()
    await waitFor(() => expect(mockListCooldowns).toHaveBeenCalled())
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
    ["custom", "panel-custom"],
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

  it("refreshes status after the keys panel changes", async () => {
    searchString = "gatewayPanel=keys"
    const user = userEvent.setup()
    render(<GatewaySection />)
    await screen.findByTestId("panel-keys")
    mockGetStatus.mockClear()

    await user.click(screen.getByTestId("stub-keys-changed"))

    expect(mockGetStatus).toHaveBeenCalled()
  })

  it("badges the upstream panel with the parked-key count from any panel", async () => {
    mockListCooldowns.mockResolvedValue([
      { providerId: "openai", keyHint: "…1", untilMs: 0, permanent: false, reason: "429" },
      { providerId: "groq", keyHint: "…2", untilMs: 0, permanent: false, reason: "429" },
    ])
    render(<GatewaySection />)

    expect(await screen.findByTestId("gateway-nav-badge-upstream")).toHaveTextContent("2")
  })

  it("uses a destructive upstream badge when any cooldown is permanent", async () => {
    mockListCooldowns.mockResolvedValue([
      { providerId: "openai", keyHint: "…1", untilMs: 0, permanent: true, reason: "revoked" },
    ])
    render(<GatewaySection />)

    expect(await screen.findByTestId("gateway-nav-badge-upstream")).toHaveAttribute(
      "data-variant",
      "destructive"
    )
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

    it("normalizes non-Error listener failures", async () => {
      const { toast } = jest.requireMock("sonner")
      mockStart.mockRejectedValue("start failed")
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-start"))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("start failed"))
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

    it("replaces the complete custom configuration and starts the listener", async () => {
      searchString = "gatewayPanel=custom"
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-custom")

      await user.click(screen.getByTestId("stub-replace"))

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, port: 50002 })
      )
      expect(mockStart).toHaveBeenCalled()
    })

    it("marks listener and custom navigation when a running bind changes", async () => {
      searchString = "gatewayPanel=custom"
      mockGetStatus.mockResolvedValue(status({ running: true, boundPort: 47823 }))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-custom")

      await user.click(screen.getByTestId("stub-replace"))

      expect(await screen.findByTestId("gateway-nav-badge-listener")).toHaveTextContent("!")
      expect(screen.getByTestId("gateway-nav-badge-custom")).toHaveTextContent("!")
    })

    it("marks a running listener for restart after a guided bind edit", async () => {
      mockGetConfig.mockResolvedValue(config({ enabled: true }))
      mockGetStatus.mockResolvedValue(status({ running: true, boundPort: 47823 }))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")
      await waitFor(() => expect(screen.getByTestId("stub-running")).toHaveTextContent("true"))

      await user.click(screen.getByTestId("stub-persist"))

      expect(await screen.findByTestId("gateway-nav-badge-listener")).toHaveTextContent("!")
    })

    it.each(["stub-persist-bind", "stub-persist-allowlist"])(
      "marks a running listener after the %s network setting changes",
      async (testId) => {
        mockGetConfig.mockResolvedValue(config({ enabled: true }))
        mockGetStatus.mockResolvedValue(status({ running: true, boundPort: 47823 }))
        const user = userEvent.setup()
        render(<GatewaySection />)
        await screen.findByTestId("panel-overview")
        await waitFor(() => expect(screen.getByTestId("stub-running")).toHaveTextContent("true"))

        await user.click(screen.getByTestId(testId))

        expect(await screen.findByTestId("gateway-nav-badge-listener")).toHaveTextContent("!")
      }
    )

    it("normalizes non-Error guided config failures", async () => {
      const { toast } = jest.requireMock("sonner")
      mockUpdate.mockRejectedValue("write failed")
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-overview")

      await user.click(screen.getByTestId("stub-persist"))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("write failed"))
    })

    it("rejects a custom enabled config without a usable key", async () => {
      const { toast } = jest.requireMock("sonner")
      searchString = "gatewayPanel=custom"
      mockGetStatus.mockResolvedValue(status({ hasToken: false }))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-custom")

      await user.click(screen.getByTestId("stub-replace"))

      expect(mockUpdate).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith("requiresKey")
    })

    it("stops the listener when a custom replacement disables it", async () => {
      searchString = "gatewayPanel=custom"
      mockGetConfig.mockResolvedValue(config({ enabled: true }))
      mockGetStatus.mockResolvedValue(status({ running: true }))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-custom")

      await user.click(screen.getByTestId("stub-replace-disabled"))

      expect(mockStop).toHaveBeenCalled()
    })

    it("refreshes authoritative state and rethrows custom replacement failures", async () => {
      const { toast } = jest.requireMock("sonner")
      searchString = "gatewayPanel=custom"
      mockUpdate.mockRejectedValue("write failed")
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-custom")
      mockGetConfig.mockClear()

      await user.click(screen.getByTestId("stub-replace"))

      await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
      expect(toast.error).toHaveBeenCalledWith("write failed")
    })

    it("clears restart state after the listener reports a restart", async () => {
      searchString = "gatewayPanel=listener"
      mockGetConfig.mockResolvedValue(config({ enabled: true }))
      mockGetStatus.mockResolvedValue(status({ running: true, boundPort: 47823 }))
      const user = userEvent.setup()
      render(<GatewaySection />)
      await screen.findByTestId("panel-listener")
      await user.click(screen.getByTestId("stub-listener-persist"))
      await screen.findByTestId("gateway-nav-badge-listener")

      await user.click(screen.getByTestId("stub-restarted"))

      await waitFor(() =>
        expect(screen.queryByTestId("gateway-nav-badge-listener")).not.toBeInTheDocument()
      )
    })
  })
})
