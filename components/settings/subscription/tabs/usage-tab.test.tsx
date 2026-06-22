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
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
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
    expect(screen.getByTestId("usage-cost-chart")).toBeInTheDocument()
    // The representative window earns a badge.
    expect(screen.getByText("Representative")).toBeInTheDocument()
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
    expect(screen.queryByTestId("usage-cost-chart")).not.toBeInTheDocument()
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
    expect(screen.queryByTestId("usage-cost-chart")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("usage-expand-all"))
    expect(screen.getByTestId("usage-cost-chart")).toBeInTheDocument()
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
