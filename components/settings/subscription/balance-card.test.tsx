/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SubscriptionBalanceRow } from "@/types/subscription"

// next-intl is globally mocked against en.json in jest.setup.ts.

const useAccountBalanceMock = jest.fn()
jest.mock("@/lib/subscription/balance/hooks", () => ({
  useAccountBalance: (...a: unknown[]) => useAccountBalanceMock(...a),
}))

import { BalanceCard } from "./balance-card"

function row(over: Partial<SubscriptionBalanceRow> = {}): SubscriptionBalanceRow {
  return {
    localId: 1,
    fetchedAt: 1700000000000,
    providerKey: "deepseek",
    accountId: "acc-1",
    kind: "credit",
    currency: "CNY",
    unit: "CNY",
    remaining: 42.5,
    raw: {},
    ...over,
  }
}

function setup(over: Partial<ReturnType<typeof base>> = {}) {
  useAccountBalanceMock.mockReturnValue({ ...base(), ...over })
}

function base() {
  return {
    snapshot: null as SubscriptionBalanceRow | null,
    refreshing: false,
    unavailable: false,
    refresh: jest.fn(async () => {}),
  }
}

beforeEach(() => jest.clearAllMocks())

describe("BalanceCard", () => {
  it("renders the empty state before any fetch", () => {
    setup()
    render(<BalanceCard provider="codex" accountId="acc-1" label="DeepSeek" />)
    expect(screen.getByTestId("balance-empty-acc-1")).toBeInTheDocument()
  })

  it("renders remaining with currency and the fetched timestamp", () => {
    setup({ snapshot: row() })
    render(<BalanceCard provider="codex" accountId="acc-1" label="DeepSeek" />)
    expect(screen.getByTestId("balance-remaining-acc-1")).toHaveTextContent("42.50 CNY")
    expect(screen.getByTestId("balance-fetched-acc-1")).toBeInTheDocument()
  })

  it("renders total and used when present", () => {
    setup({ snapshot: row({ total: 50, used: 7.5, currency: "USD", unit: "USD" }) })
    render(<BalanceCard provider="codex" accountId="acc-1" />)
    expect(screen.getByTestId("balance-total-acc-1")).toHaveTextContent("50.00 USD")
    expect(screen.getByTestId("balance-used-acc-1")).toHaveTextContent("7.50 USD")
  })

  it("shows the error state when the snapshot carries an error", () => {
    setup({ snapshot: row({ error: "HTTP 401", remaining: undefined }) })
    render(<BalanceCard provider="codex" accountId="acc-1" />)
    expect(screen.getByTestId("balance-error-acc-1")).toHaveTextContent("HTTP 401")
  })

  it("shows the unavailable state when no adapter matched", () => {
    setup({ unavailable: true })
    render(<BalanceCard provider="codex" accountId="acc-1" />)
    expect(screen.getByTestId("balance-unavailable-acc-1")).toBeInTheDocument()
  })

  it("invokes refresh on button click", async () => {
    const refresh = jest.fn(async () => {})
    setup({ refresh })
    const user = userEvent.setup()
    render(<BalanceCard provider="codex" accountId="acc-1" />)
    await user.click(screen.getByTestId("balance-refresh-acc-1"))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("disables the refresh button while refreshing", () => {
    setup({ refreshing: true })
    render(<BalanceCard provider="codex" accountId="acc-1" />)
    expect(screen.getByTestId("balance-refresh-acc-1")).toBeDisabled()
  })

  it("falls back to the accountId when no label is given", () => {
    setup()
    render(<BalanceCard provider="codex" accountId="acc-1" />)
    expect(screen.getByText("acc-1")).toBeInTheDocument()
  })
})
