/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// next-intl is globally mocked against en.json in jest.setup.ts.

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

type Cred = { mode: string } | null
let credentialResult: { credential: Cred; activeAccountId: string | null } = {
  credential: { mode: "subscription" },
  activeAccountId: "acc-1",
}
let latestRow: unknown = null
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: () => credentialResult,
  useAnthropicUsage: () => ({
    rows: latestRow ? [latestRow] : [],
    latest: latestRow,
    loading: false,
  }),
}))

const refreshMock = jest.fn()
let limitsResult: { snapshot: unknown; refreshing: boolean } = { snapshot: null, refreshing: false }
jest.mock("@/lib/subscription/limits/hooks", () => ({
  useProviderLimits: () => ({ ...limitsResult, unavailable: false, refresh: refreshMock }),
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: { settings: unknown }) => unknown) =>
    selector({ settings: undefined }),
}))

import { SubscriptionOverviewTab } from "./overview-tab"

const NOW = Date.now()

function endpointSnapshot(fetchedAt = NOW) {
  return {
    provider: "anthropic",
    accountId: "acc-1",
    fetchedAt,
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
        resetAt: NOW + 6 * 86_400_000,
        status: "ok",
      },
      {
        id: "weekly_opus",
        labelKey: "subscription.limits.meter.weekly_opus",
        kind: "window",
        usedPct: 7,
        resetAt: NOW + 6 * 86_400_000,
        status: "ok",
      },
      {
        id: "overage",
        labelKey: "subscription.limits.meter.overage",
        kind: "balance",
        usedPct: 10,
        resetAt: null,
        status: "ok",
        remaining: 45,
        currency: "USD",
      },
    ],
  }
}

function headerSample(overrides: Record<string, unknown> = {}) {
  return {
    localId: 1,
    fetchedAt: NOW - 60_000,
    source: "passive",
    status: "allowed_warning",
    representativeClaim: "five_hour",
    fiveHour: { utilization: 0.93, resetAt: NOW + 3_600_000, status: "allowed_warning" },
    sevenDay: { utilization: 0.4, resetAt: NOW + 86_400_000, status: "allowed" },
    fallbackPercentage: null,
    overageDisabledReason: null,
    rawHeaders: {},
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  credentialResult = { credential: { mode: "subscription" }, activeAccountId: "acc-1" }
  latestRow = null
  limitsResult = { snapshot: null, refreshing: false }
})

describe("SubscriptionOverviewTab", () => {
  it("shows the web banner outside Tauri", () => {
    isTauriMock.mockReturnValue(false)
    render(<SubscriptionOverviewTab />)
    expect(screen.queryByTestId("overview-windows")).not.toBeInTheDocument()
  })

  it("signed out → CTA that opens the add-account dialog", async () => {
    credentialResult = { credential: null, activeAccountId: null }
    const onRequestAddAccount = jest.fn()
    render(<SubscriptionOverviewTab onRequestAddAccount={onRequestAddAccount} />)
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(onRequestAddAccount).toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("no data → empty state with a working refresh CTA, plus an auto-fetch", async () => {
    render(<SubscriptionOverviewTab />)
    expect(screen.getByText("No usage data yet")).toBeInTheDocument()
    // Mount auto-fetch fires once because the data is missing.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTestId("overview-refresh"))
    expect(refreshMock).toHaveBeenCalledTimes(2)
  })

  // A failed query used to render the same "No usage data yet" copy as an idle
  // account, which is how a throttled/expired quota read stayed invisible.
  it("failed query → the reason replaces the generic empty copy", () => {
    limitsResult = {
      snapshot: {
        provider: "anthropic",
        accountId: "acc-1",
        fetchedAt: NOW,
        meters: [],
        error: "429 Too Many Requests: slow down",
      },
      refreshing: false,
    }
    render(<SubscriptionOverviewTab />)
    expect(screen.getByText(/429 Too Many Requests/)).toBeInTheDocument()
    // The "just fetch it, it's free" pitch is wrong once the fetch is failing.
    expect(screen.queryByText(/no token cost/)).not.toBeInTheDocument()
    // The refresh CTA must survive the error branch.
    expect(screen.getByTestId("overview-refresh")).toBeInTheDocument()
  })

  it("renders all endpoint windows in the grid plus the overage extra", () => {
    limitsResult = { snapshot: endpointSnapshot(), refreshing: false }
    render(<SubscriptionOverviewTab />)
    expect(screen.getByTestId("overview-window-session")).toBeInTheDocument()
    expect(screen.getByTestId("overview-window-weekly")).toBeInTheDocument()
    expect(screen.getByTestId("overview-window-weekly_opus")).toBeInTheDocument()
    expect(screen.getByTestId("overview-extras")).toBeInTheDocument()
    expect(screen.getByTestId("overview-status")).toHaveTextContent("All clear")
    expect(screen.getByText(/Live usage API/)).toBeInTheDocument()
  })

  it("fresh endpoint data suppresses the mount auto-fetch", async () => {
    limitsResult = { snapshot: endpointSnapshot(NOW - 1000), refreshing: false }
    render(<SubscriptionOverviewTab />)
    // Give the effect a tick; it must decide the data is fresh and skip.
    await waitFor(() => expect(screen.getByTestId("overview-windows")).toBeInTheDocument())
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("falls back to header samples with unified status + representative badge", () => {
    latestRow = headerSample()
    render(<SubscriptionOverviewTab />)
    expect(screen.getByTestId("overview-window-session")).toBeInTheDocument()
    expect(screen.getByTestId("overview-window-weekly")).toBeInTheDocument()
    expect(screen.getByTestId("overview-status")).toHaveTextContent("Warning")
    expect(screen.getByText(/From chat response headers/)).toBeInTheDocument()
    expect(screen.getByText("Representative")).toBeInTheDocument()
  })

  it("surfaces the overage-disabled reason from the header sample", () => {
    latestRow = headerSample({ overageDisabledReason: "out_of_credits" })
    render(<SubscriptionOverviewTab />)
    expect(screen.getByText(/Overage disabled: out_of_credits/)).toBeInTheDocument()
  })

  it("manual refresh button is disabled while a fetch is in flight", () => {
    limitsResult = { snapshot: endpointSnapshot(), refreshing: true }
    render(<SubscriptionOverviewTab />)
    expect(screen.getByTestId("overview-refresh")).toBeDisabled()
  })
})
