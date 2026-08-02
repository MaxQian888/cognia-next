/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SubscriptionUsageRow } from "@/types/subscription"
import type { SessionUsageRow } from "@/lib/db/session-usage"

// next-intl is globally mocked against en.json in jest.setup.ts.

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

// Stub the share-card dialog — its ShareLinkDialog/html2canvas-pro stack is
// covered by usage-share-dialog.test.tsx and would drag stores into this
// suite's module graph.
jest.mock("@/components/settings/subscription/usage-share-dialog", () => ({
  UsageShareDialog: ({ trigger }: { trigger?: React.ReactNode }) => <>{trigger}</>,
}))

const useAnthropicUsageMock = jest.fn()
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useAnthropicUsage: () => useAnthropicUsageMock(),
}))

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => useLiveQueryMock() }))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessionUsage: { toArray: jest.fn() } }),
}))

jest.mock("@/lib/db/sessions", () => ({ listSessions: jest.fn(async () => []) }))

const downloadBlobMock = jest.fn()
jest.mock("@/lib/files/download", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlobMock(...args),
}))

const setActiveSessionMock = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: { setActiveSession: unknown }) => unknown) =>
    selector({ setActiveSession: setActiveSessionMock }),
}))

const refreshLimitsMock = jest.fn()
const useProviderLimitsMock = jest.fn()
jest.mock("@/lib/subscription/limits/hooks", () => ({
  useProviderLimits: (...args: unknown[]) => useProviderLimitsMock(...args),
}))

const useAccountsMock = jest.fn()
jest.mock("@/lib/subscription/core/hooks", () => ({
  useAccounts: (provider: string) => useAccountsMock(provider),
}))

jest.mock("@/components/settings/subscription/balance-card", () => ({
  BalanceCard: ({ provider, accountId }: { provider: string; accountId: string }) => (
    <div data-testid={`mock-balance-${provider}-${accountId}`}>balance</div>
  ),
}))

jest.mock("@/components/settings/subscription/limits-meters-card", () => ({
  LimitsMetersCard: ({ provider, accountId }: { provider: string; accountId: string }) => (
    <div data-testid={`mock-limits-${provider}-${accountId}`}>limits</div>
  ),
}))

// Motion primitives → deterministic passthrough; reduce=true also disables
// recharts/count-up animation for stable jsdom output.
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
  MotionReveal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MotionCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  MotionStatusSwap: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

let currentMode = "standard"
const setUsageModeMock = jest.fn()
jest.mock("@/hooks/usage/use-usage-display-mode", () => ({
  useUsageDisplayMode: () => ({ mode: currentMode, setMode: setUsageModeMock }),
}))

import { SubscriptionUsageTab } from "./usage-tab"

const NOW = Date.now()

function snapshot(overrides: Partial<SubscriptionUsageRow> = {}): SubscriptionUsageRow {
  return {
    localId: Math.floor(Math.random() * 1e6),
    fetchedAt: NOW,
    source: "passive",
    status: "allowed",
    representativeClaim: "five_hour",
    fiveHour: { utilization: 0.4, resetAt: NOW + 3_600_000, status: "allowed" },
    sevenDay: { utilization: 0.1, resetAt: NOW + 7 * 86_400_000, status: "allowed" },
    fallbackPercentage: null,
    overageDisabledReason: null,
    rawHeaders: {},
    ...overrides,
  }
}

function usageRow(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    at: NOW,
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.25,
    durationMs: 1200,
    ...overrides,
  }
}

function setup({
  rows = [snapshot()],
  loading = false,
  sessionRows = [usageRow()],
}: {
  rows?: SubscriptionUsageRow[]
  loading?: boolean
  sessionRows?: SessionUsageRow[]
} = {}) {
  useAnthropicUsageMock.mockReturnValue({ rows, latest: rows[0] ?? null, loading })
  useLiveQueryMock.mockReturnValue(sessionRows)
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  useAccountsMock.mockReturnValue({ accounts: [], activeAccountId: null })
  useProviderLimitsMock.mockReturnValue({
    snapshot: null,
    refreshing: false,
    unavailable: false,
    refresh: refreshLimitsMock,
  })
  currentMode = "standard"
})

describe("SubscriptionUsageTab", () => {
  it("shows the web-mode banner outside Tauri", () => {
    isTauriMock.mockReturnValue(false)
    setup()
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-web-banner")).toBeInTheDocument()
    expect(screen.queryByTestId("usage-tab")).not.toBeInTheDocument()
  })

  it("shows a loading hint while the usage hook loads", () => {
    setup({ loading: true })
    render(<SubscriptionUsageTab />)
    expect(screen.queryByTestId("usage-tab")).not.toBeInTheDocument()
  })

  it("shows the empty state when there is no data at all", () => {
    setup({ rows: [], sessionRows: [] })
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-empty")).toBeInTheDocument()
  })

  it("renders the full dashboard with data", () => {
    setup()
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-tab")).toBeInTheDocument()
    expect(screen.getByTestId("usage-current-window")).toBeInTheDocument()
    expect(screen.getByTestId("usage-window-5h")).toBeInTheDocument()
    expect(screen.getByTestId("usage-window-7d")).toBeInTheDocument()
    expect(screen.getByTestId("usage-trend-chart")).toBeInTheDocument()
    expect(screen.getByTestId("usage-model-stat-cost")).toBeInTheDocument()
    expect(screen.getByTestId("usage-cost-heatmap")).toBeInTheDocument()
    // The representative window earns a badge.
    expect(screen.getByText("Representative")).toBeInTheDocument()
  })

  it("surfaces model throughput as a headline stat tile", () => {
    // Fixture row: 500 output tokens over 1200ms → ~417 tok/s.
    setup()
    render(<SubscriptionUsageTab />)
    const speed = screen.getByTestId("usage-model-stat-speed")
    expect(speed).toHaveTextContent("tok/s")
  })

  it("renders an em-dash speed tile when no turn reported a duration", () => {
    setup({ sessionRows: [usageRow({ durationMs: 0 })] })
    render(<SubscriptionUsageTab />)
    const speed = screen.getByTestId("usage-model-stat-speed")
    expect(speed).toHaveTextContent("—")
    expect(speed).not.toHaveTextContent("tok/s")
  })

  it("surfaces contributing-factor insights derived from the session rows", () => {
    setup({
      sessionRows: [
        usageRow({ inputTokens: 200_000, costUsd: 1 }),
        usageRow({ messageId: "m2", surface: "agent-team", costUsd: 1 }),
      ],
    })
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-insights-section")).toBeInTheDocument()
    expect(screen.getByTestId("usage-insight-high-context")).toBeInTheDocument()
    expect(screen.getByTestId("usage-insight-automated-surface")).toBeInTheDocument()
  })

  it("shows the insights empty hint when no characteristic applies", () => {
    setup({ sessionRows: [usageRow({ inputTokens: 1000, surface: "chat", costUsd: 0.25 })] })
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-insights-empty")).toBeInTheDocument()
  })

  it("computes the cache hit rate stat from cacheRead / (input + cacheRead)", () => {
    setup({
      sessionRows: [
        usageRow({ inputTokens: 250, cacheReadTokens: 750 }),
        usageRow({ messageId: "m2", inputTokens: 250, cacheReadTokens: 750 }),
      ],
    })
    render(<SubscriptionUsageTab />)
    const stat = screen.getByTestId("usage-model-stat-cache-hit-rate")
    expect(stat).toBeInTheDocument()
    expect(stat).toHaveTextContent("75%")
  })

  it("shows a 0% cache hit rate when nothing was cached", () => {
    setup({ sessionRows: [usageRow({ inputTokens: 1000, cacheReadTokens: 0 })] })
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-model-stat-cache-hit-rate")).toHaveTextContent("0%")
  })

  it("surfaces the overage-disabled alert when present", () => {
    setup({ rows: [snapshot({ overageDisabledReason: "billing_issue" })] })
    render(<SubscriptionUsageTab />)
    expect(screen.getByText(/billing_issue/)).toBeInTheDocument()
  })

  it("switches the active range", async () => {
    const user = userEvent.setup()
    setup()
    render(<SubscriptionUsageTab />)
    const sevenDay = screen.getByTestId("usage-range-7d")
    const thirtyDay = screen.getByTestId("usage-range-30d")
    expect(sevenDay).toHaveAttribute("aria-pressed", "true")
    await user.click(thirtyDay)
    expect(thirtyDay).toHaveAttribute("aria-pressed", "true")
    expect(sevenDay).toHaveAttribute("aria-pressed", "false")
  })

  it("offers a 90-day range and no longer offers all-time", async () => {
    const user = userEvent.setup()
    setup({ sessionRows: [usageRow({ at: NOW - 60 * 86_400_000 })] })
    render(<SubscriptionUsageTab />)
    expect(screen.queryByTestId("usage-range-all")).not.toBeInTheDocument()
    const ninety = screen.getByTestId("usage-range-90d")
    expect(ninety).toHaveTextContent("Last 90 days")
    // A 60-day-old row is out of the 7-day default and back in range at 90d.
    expect(screen.getByTestId("usage-cost-empty")).toBeInTheDocument()
    await user.click(ninety)
    expect(ninety).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("usage-cost-heatmap")).toBeInTheDocument()
  })

  describe("cost over time", () => {
    /** Local "YYYY-MM-DD" for an epoch-ms instant — matches the cell testids. */
    const dayKey = (at: number) => {
      const d = new Date(at)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`
    }

    it("defaults to the heatmap and switches to the bar chart", async () => {
      const user = userEvent.setup()
      setup()
      render(<SubscriptionUsageTab />)
      expect(screen.getByTestId("usage-cost-heatmap")).toBeInTheDocument()
      expect(screen.queryByTestId("usage-cost-chart")).not.toBeInTheDocument()
      expect(screen.getByTestId("usage-cost-view-heatmap")).toHaveAttribute("data-state", "on")

      await user.click(screen.getByTestId("usage-cost-view-bar"))
      expect(screen.getByTestId("usage-cost-chart")).toBeInTheDocument()
      expect(screen.queryByTestId("usage-cost-heatmap")).not.toBeInTheDocument()
    })

    it("keeps a view selected when the active toggle item is clicked again", async () => {
      const user = userEvent.setup()
      setup()
      render(<SubscriptionUsageTab />)
      // Radix emits "" when a single-select item is deselected; the guard keeps
      // the section from rendering neither view.
      await user.click(screen.getByTestId("usage-cost-view-heatmap"))
      expect(screen.getByTestId("usage-cost-heatmap")).toBeInTheDocument()
    })

    it("paints one cell per day in range, carrying the localized date and cost", () => {
      setup()
      render(<SubscriptionUsageTab />)
      const cells = screen.getAllByTestId(/^usage-cost-heatmap-cell-/)
      expect(cells).toHaveLength(7)
      // The fixture row is priced at $0.25 today; the rest of the week is empty.
      const today = screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW)}`)
      expect(today).toHaveAttribute("data-level", "4")
      expect(today.getAttribute("aria-label")).toMatch(/\$0\.25/)
      expect(today.getAttribute("aria-label")).toMatch(/1 request/)
      const yesterday = screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW - 86_400_000)}`)
      expect(yesterday).toHaveAttribute("data-level", "0")
      // `formatCostInCurrency` renders a zero total as "Free".
      expect(yesterday.getAttribute("aria-label")).toMatch(/Free/)
      expect(yesterday.getAttribute("aria-label")).toMatch(/no requests/)
    })

    it("grows the grid with the selected range", async () => {
      const user = userEvent.setup()
      setup()
      render(<SubscriptionUsageTab />)
      await user.click(screen.getByTestId("usage-range-30d"))
      expect(screen.getAllByTestId(/^usage-cost-heatmap-cell-/)).toHaveLength(30)
      await user.click(screen.getByTestId("usage-range-90d"))
      expect(screen.getAllByTestId(/^usage-cost-heatmap-cell-/)).toHaveLength(90)
    })

    it("scales cell intensity against the busiest day in range", () => {
      setup({
        sessionRows: [
          usageRow({ messageId: "hot", at: NOW, costUsd: 4 }),
          usageRow({ messageId: "cold", at: NOW - 2 * 86_400_000, costUsd: 0.5 }),
        ],
      })
      render(<SubscriptionUsageTab />)
      expect(screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW)}`)).toHaveAttribute(
        "data-level",
        "4"
      )
      expect(
        screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW - 2 * 86_400_000)}`)
      ).toHaveAttribute("data-level", "1")
    })

    it("scopes the heatmap to the active surface filter", async () => {
      const user = userEvent.setup()
      setup({
        sessionRows: [
          usageRow({ messageId: "c1", at: NOW, surface: "chat", costUsd: 1 }),
          usageRow({
            messageId: "w1",
            at: NOW - 3 * 86_400_000,
            surface: "workflow",
            costUsd: 1,
          }),
        ],
      })
      render(<SubscriptionUsageTab />)
      await user.click(screen.getByTestId("usage-surface-workflow"))
      expect(screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW)}`)).toHaveAttribute(
        "data-level",
        "0"
      )
      expect(
        screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW - 3 * 86_400_000)}`)
      ).toHaveAttribute("data-level", "4")
    })

    it("summarizes the range and labels the intensity legend", () => {
      setup()
      render(<SubscriptionUsageTab />)
      const total = screen.getByTestId("usage-cost-heatmap-total")
      expect(total).toHaveTextContent("$0.25")
      expect(total).toHaveTextContent("7 days")
      expect(screen.getByText("Less")).toBeInTheDocument()
      expect(screen.getByText("More")).toBeInTheDocument()
    })

    it("opens the same tooltip on hover and on keyboard focus", async () => {
      const user = userEvent.setup()
      setup()
      render(<SubscriptionUsageTab />)
      const today = screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW)}`)
      const label = today.getAttribute("aria-label") as string

      await user.hover(today)
      const hovered = await screen.findByRole("tooltip")
      expect(hovered).toHaveTextContent(label)

      await user.unhover(today)
      today.focus()
      const focused = await screen.findByRole("tooltip")
      expect(focused).toHaveTextContent(label)
    })
  })

  it("exports usage rows as CSV", async () => {
    const user = userEvent.setup()
    setup()
    render(<SubscriptionUsageTab />)
    await user.click(screen.getByTestId("usage-export-trigger"))
    await user.click(await screen.findByTestId("usage-export-csv"))
    expect(downloadBlobMock).toHaveBeenCalledTimes(1)
    const [blob, filename] = downloadBlobMock.mock.calls[0] as [Blob, string]
    expect(blob).toBeInstanceOf(Blob)
    expect(filename).toMatch(/^cognia-usage-.*\.csv$/)
  })

  it("disables export when the active range has no billable rows", () => {
    // A session row well outside the default 7-day window.
    setup({ sessionRows: [usageRow({ at: NOW - 60 * 86_400_000 })] })
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-export-trigger")).toBeDisabled()
  })

  it("renders the balance + unified limits cards for the active non-anthropic account", () => {
    setup()
    useAccountsMock.mockImplementation((provider: string) =>
      provider === "codex"
        ? { accounts: [{ id: "acc-1", label: "DeepSeek" }], activeAccountId: "acc-1" }
        : { accounts: [], activeAccountId: null }
    )
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("balances-section")).toBeInTheDocument()
    expect(screen.getByTestId("mock-balance-codex-acc-1")).toBeInTheDocument()
    expect(screen.getByTestId("mock-limits-codex-acc-1")).toBeInTheDocument()
  })

  it("renders no provider cards when no non-anthropic account is active", () => {
    setup()
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("balances-section")).toBeInTheDocument()
    expect(screen.queryByTestId(/^mock-balance-/)).not.toBeInTheDocument()
    expect(screen.queryByTestId(/^mock-limits-/)).not.toBeInTheDocument()
  })

  it("hides the surface filter when only chat usage exists", () => {
    setup({ sessionRows: [usageRow({ surface: "chat" })] })
    render(<SubscriptionUsageTab />)
    expect(screen.queryByTestId("usage-surface-filter")).not.toBeInTheDocument()
  })

  it("shows the surface filter once non-chat spend appears and scopes the cards", async () => {
    const user = userEvent.setup()
    setup({
      sessionRows: [
        usageRow({ messageId: "c1", model: "chat-model", surface: "chat" }),
        usageRow({ messageId: "w1", model: "wf-model", surface: "workflow" }),
      ],
    })
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-surface-filter")).toBeInTheDocument()
    // "All" shows both models in the breakdown table.
    expect(screen.getByTestId("usage-model-row-chat-model")).toBeInTheDocument()
    expect(screen.getByTestId("usage-model-row-wf-model")).toBeInTheDocument()
    // Narrowing to workflow drops the chat-only model.
    await user.click(screen.getByTestId("usage-surface-workflow"))
    expect(screen.getByTestId("usage-surface-workflow")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("usage-model-row-wf-model")).toBeInTheDocument()
    expect(screen.queryByTestId("usage-model-row-chat-model")).not.toBeInTheDocument()
  })

  it("collapses charts and tables by default in simplified mode", () => {
    currentMode = "simplified"
    setup()
    render(<SubscriptionUsageTab />)
    // Headline tiles + current window stay open …
    expect(screen.getByTestId("usage-stat-grid")).toBeInTheDocument()
    expect(screen.getByTestId("usage-current-window")).toBeInTheDocument()
    // … but the charts/tables fold shut (bodies unmounted by MotionCollapse).
    expect(screen.queryByTestId("usage-trend-chart")).not.toBeInTheDocument()
    expect(screen.queryByTestId("usage-cost-heatmap")).not.toBeInTheDocument()
    expect(screen.queryByTestId("usage-model-donut")).not.toBeInTheDocument()
  })

  it("opens the raw snapshot table and extra columns in detailed mode", () => {
    currentMode = "detailed"
    setup()
    render(<SubscriptionUsageTab />)
    // Raw snapshots open only in detailed.
    expect(screen.getByText(/Fetched at/)).toBeInTheDocument()
    // Cache-write column appears only in detailed.
    expect(screen.getByText("Cache write")).toBeInTheDocument()
  })

  it("expand-all reopens a section folded shut in simplified mode", async () => {
    const user = userEvent.setup()
    currentMode = "simplified"
    setup()
    render(<SubscriptionUsageTab />)
    expect(screen.queryByTestId("usage-cost-heatmap")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("usage-expand-all"))
    expect(screen.getByTestId("usage-cost-heatmap")).toBeInTheDocument()
  })

  it("collapse-all folds the open sections in standard mode", async () => {
    const user = userEvent.setup()
    setup()
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-trend-chart")).toBeInTheDocument()
    await user.click(screen.getByTestId("usage-collapse-all"))
    expect(screen.queryByTestId("usage-trend-chart")).not.toBeInTheDocument()
  })

  it("toggles a single section open and shut via its header", async () => {
    const user = userEvent.setup()
    setup()
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-trend-chart")).toBeInTheDocument()
    await user.click(screen.getByTestId("usage-trend-section-header"))
    expect(screen.queryByTestId("usage-trend-chart")).not.toBeInTheDocument()
  })

  it("renders the model/cost/session empty states when no session usage is recorded", () => {
    // Snapshot data present (so it's not the all-empty guard), but no per-turn
    // rows → the stat grid is hidden and the session-derived cards go empty.
    setup({ rows: [snapshot()], sessionRows: [] })
    render(<SubscriptionUsageTab />)
    expect(screen.queryByTestId("usage-stat-grid")).not.toBeInTheDocument()
    expect(screen.getByTestId("usage-models-empty")).toBeInTheDocument()
    expect(screen.getByTestId("usage-cost-empty")).toBeInTheDocument()
    expect(screen.getByTestId("usage-top-empty")).toBeInTheDocument()
  })

  it("shows the no-snapshot / empty-trend states when only session usage exists", () => {
    setup({ rows: [], sessionRows: [usageRow()] })
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-window-empty")).toBeInTheDocument()
    expect(screen.getByTestId("usage-trend-empty")).toBeInTheDocument()
    // Raw snapshots open in detailed mode but have nothing to show.
    currentMode = "detailed"
  })

  it("renders the detailed raw-snapshot empty state with no snapshots in range", () => {
    currentMode = "detailed"
    setup({ rows: [], sessionRows: [usageRow()] })
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-raw-empty")).toBeInTheDocument()
  })

  it("prefers a newer endpoint snapshot: opus/sonnet gauges + live-source line", () => {
    useProviderLimitsMock.mockReturnValue({
      snapshot: {
        provider: "anthropic",
        accountId: "acc-1",
        fetchedAt: NOW + 1000,
        meters: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            kind: "window",
            usedPct: 42,
            resetAt: NOW + 3_600_000,
            status: "ok",
          },
          {
            id: "weekly",
            labelKey: "subscription.limits.meter.weekly",
            kind: "window",
            usedPct: 12,
            resetAt: NOW + 86_400_000,
            status: "ok",
          },
          {
            id: "weekly_opus",
            labelKey: "subscription.limits.meter.weekly_opus",
            kind: "window",
            usedPct: 7,
            resetAt: NOW + 86_400_000,
            status: "ok",
          },
          {
            id: "weekly_sonnet",
            labelKey: "subscription.limits.meter.weekly_sonnet",
            kind: "window",
            usedPct: 3,
            resetAt: NOW + 86_400_000,
            status: "ok",
          },
        ],
      },
      refreshing: false,
      unavailable: false,
      refresh: refreshLimitsMock,
    })
    useAccountsMock.mockReturnValue({ accounts: [], activeAccountId: "acc-1" })
    setup()
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-window-5h")).toHaveTextContent("42%")
    expect(screen.getByTestId("usage-window-7d")).toHaveTextContent("12%")
    expect(screen.getByTestId("usage-window-7d-opus")).toBeInTheDocument()
    expect(screen.getByTestId("usage-window-7d-sonnet")).toBeInTheDocument()
    expect(screen.getByTestId("usage-window-source")).toHaveTextContent("Live usage API")
  })

  it("window refresh button triggers a limits refetch for the active account", async () => {
    useAccountsMock.mockReturnValue({ accounts: [], activeAccountId: "acc-1" })
    setup()
    render(<SubscriptionUsageTab />)
    // The codex/opencode quota panels may auto-fetch on mount with the same
    // shared mock — assert the click adds exactly one more call.
    const before = refreshLimitsMock.mock.calls.length
    await userEvent.click(screen.getByTestId("usage-window-refresh"))
    expect(refreshLimitsMock).toHaveBeenCalledTimes(before + 1)
  })

  it("window refresh button is disabled without an active anthropic account", () => {
    setup()
    render(<SubscriptionUsageTab />)
    expect(screen.getByTestId("usage-window-refresh")).toBeDisabled()
  })

  it("renders a no-data gauge and expired countdown for a missing/elapsed window", () => {
    setup({
      rows: [
        snapshot({
          fiveHour: { utilization: 0.4, resetAt: NOW - 1000, status: "allowed" },
          sevenDay: null,
        }),
      ],
      sessionRows: [usageRow()],
    })
    render(<SubscriptionUsageTab />)
    // 7d window absent → no-data gauge; 5h reset is in the past → expired label.
    expect(screen.getByTestId("usage-window-7d")).toHaveTextContent("not reported")
    expect(screen.getByTestId("usage-window-5h")).toHaveTextContent("Resetting now")
  })
})
