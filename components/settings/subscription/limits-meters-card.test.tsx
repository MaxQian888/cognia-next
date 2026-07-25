/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ProviderLimitsRow } from "@/types/subscription"

// next-intl is globally mocked against en.json in jest.setup.ts.

const useProviderLimitsMock = jest.fn()
const useCountUpMock = jest.fn((target: number, _options?: unknown) => target)
jest.mock("@/lib/subscription/limits/hooks", () => ({
  useProviderLimits: (...a: unknown[]) => useProviderLimitsMock(...a),
}))
jest.mock("@/hooks/usage/use-count-up", () => ({
  useCountUp: (target: number, options: unknown) => useCountUpMock(target, options),
}))

import { LimitsMetersCard } from "./limits-meters-card"

function row(over: Partial<ProviderLimitsRow> = {}): ProviderLimitsRow {
  return {
    localId: 1,
    provider: "codex",
    accountId: "acc-1",
    fetchedAt: 1_700_000_000_000,
    meters: [],
    ...over,
  }
}

function base() {
  return {
    snapshot: null as ProviderLimitsRow | null,
    refreshing: false,
    unavailable: false,
    refresh: jest.fn(async () => {}),
  }
}

function setup(over: Partial<ReturnType<typeof base>> = {}) {
  useProviderLimitsMock.mockReturnValue({ ...base(), ...over })
}

beforeEach(() => jest.clearAllMocks())

describe("LimitsMetersCard", () => {
  it("renders the empty state before any fetch", () => {
    setup()
    render(<LimitsMetersCard provider="codex" accountId="acc-1" label="ChatGPT" now={Date.now()} />)
    expect(screen.getByTestId("limits-empty-acc-1")).toBeInTheDocument()
  })

  it("renders a window meter with percent + reset and a credit meter", () => {
    const now = Date.now()
    setup({
      snapshot: row({
        meters: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            kind: "window",
            usedPct: 21,
            resetAt: now + 2 * 3600_000 + 5 * 60_000,
            status: "ok",
          },
          {
            id: "credit",
            labelKey: "subscription.limits.meter.credit",
            kind: "balance",
            usedPct: null,
            remaining: 88.5,
            currency: "CNY",
            status: "ok",
          },
        ],
      }),
    })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} />)
    expect(screen.getByTestId("limits-meter-acc-1-session")).toHaveTextContent("Current session")
    expect(screen.getByTestId("limits-meter-acc-1-session")).toHaveTextContent("21% used")
    expect(screen.getByTestId("limits-meter-acc-1-session")).toHaveTextContent(/Resets in 2h \d+m/)
    expect(screen.getByTestId("limits-meter-acc-1-credit")).toHaveTextContent("Credit balance")
    expect(screen.getByTestId("limits-meter-acc-1-credit")).toHaveTextContent("¥88.50 left")
    expect(screen.getByTestId("limits-fetched-acc-1")).toBeInTheDocument()
    expect(useCountUpMock).toHaveBeenCalledWith(21, expect.objectContaining({ durationMs: 500 }))
  })

  it("renders the error state", () => {
    setup({ snapshot: row({ error: "network down" }) })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} />)
    expect(screen.getByTestId("limits-error-acc-1")).toHaveTextContent("network down")
  })

  it("renders the unavailable state", () => {
    setup({ unavailable: true })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} />)
    expect(screen.getByTestId("limits-unavailable-acc-1")).toBeInTheDocument()
  })

  it("renders the no-meters state for an empty snapshot", () => {
    setup({ snapshot: row({ meters: [] }) })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} />)
    expect(screen.getByTestId("limits-none-acc-1")).toBeInTheDocument()
  })

  it("invokes refresh on click", async () => {
    const refresh = jest.fn(async () => {})
    setup({ refresh })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} />)
    await userEvent.click(screen.getByTestId("limits-refresh-acc-1"))
    expect(refresh).toHaveBeenCalled()
  })

  it("windows-only: renders nothing for a credit-only account", () => {
    setup({
      snapshot: row({
        meters: [{ id: "credit", kind: "balance", usedPct: null, remaining: 5, status: "ok" }],
      }),
    })
    const { container } = render(
      <LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} windowsOnly />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("windows-only: renders the window meter and hides the credit meter", () => {
    setup({
      snapshot: row({
        meters: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            kind: "window",
            usedPct: 30,
            resetAt: Date.now() + 3600_000,
            status: "ok",
          },
          {
            id: "credit",
            labelKey: "subscription.limits.meter.credit",
            kind: "balance",
            usedPct: null,
            remaining: 5,
            status: "ok",
          },
        ],
      }),
    })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} windowsOnly />)
    expect(screen.getByTestId("limits-meter-acc-1-session")).toBeInTheDocument()
    expect(screen.queryByTestId("limits-meter-acc-1-credit")).not.toBeInTheDocument()
  })

  it("windows-only: still surfaces an error", () => {
    setup({ snapshot: row({ error: "boom" }) })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} windowsOnly />)
    expect(screen.getByTestId("limits-error-acc-1")).toHaveTextContent("boom")
  })

  it("renders the figure/label/reset variants across meter shapes", () => {
    const now = 2_000_000_000_000
    setup({
      snapshot: row({
        meters: [
          // window, null pct → "0% used"; reset minutes-only.
          {
            id: "w0",
            label: "Custom window",
            kind: "window",
            usedPct: null,
            resetAt: now + 12 * 60_000,
            status: "ok",
          },
          // window expired reset.
          {
            id: "w1",
            label: "Expired",
            kind: "window",
            usedPct: 50,
            resetAt: now - 1000,
            status: "warn",
          },
          // balance with a unit (no currency symbol).
          {
            id: "b0",
            label: "Tokens",
            kind: "balance",
            usedPct: null,
            remaining: 1000,
            unit: "tokens",
            status: "ok",
          },
          // balance with no amount but a percent → "% used".
          {
            id: "b1",
            label: "Quota",
            kind: "balance",
            usedPct: 40,
            remaining: undefined,
            status: "warn",
          },
          // balance with nothing usable → noValue em-dash.
          {
            id: "b2",
            label: "Empty",
            kind: "balance",
            usedPct: null,
            remaining: undefined,
            status: "unknown",
          },
        ],
      }),
    })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={now} />)
    expect(screen.getByTestId("limits-meter-acc-1-w0")).toHaveTextContent("Custom window")
    expect(screen.getByTestId("limits-meter-acc-1-w0")).toHaveTextContent("0% used")
    expect(screen.getByTestId("limits-meter-acc-1-w0")).toHaveTextContent("Resets in 12m")
    expect(screen.getByTestId("limits-meter-acc-1-w1")).toHaveTextContent("Resets shortly")
    expect(screen.getByTestId("limits-meter-acc-1-b0")).toHaveTextContent("1000 tokens left")
    expect(screen.getByTestId("limits-meter-acc-1-b1")).toHaveTextContent("40% used")
    expect(screen.getByTestId("limits-meter-acc-1-b2")).toHaveTextContent("—")
  })

  it("renders a USD credit balance with the $ symbol", () => {
    setup({
      snapshot: row({
        meters: [
          {
            id: "credit",
            labelKey: "subscription.limits.meter.credit",
            kind: "balance",
            usedPct: null,
            remaining: 12.5,
            currency: "USD",
            status: "ok",
          },
        ],
      }),
    })
    render(<LimitsMetersCard provider="codex" accountId="acc-1" now={Date.now()} />)
    expect(screen.getByTestId("limits-meter-acc-1-credit")).toHaveTextContent("$12.50 left")
  })
})
