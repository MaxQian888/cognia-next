/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SubscriptionUsageRow } from "@/lib/subscription/core/types"
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
})
