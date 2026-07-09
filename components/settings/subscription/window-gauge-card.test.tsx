/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

// next-intl is globally mocked against en.json in jest.setup.ts.

import { WindowGaugeCard } from "./window-gauge-card"

import type { LimitsMeter } from "@/types/subscription"

const NOW = 1_700_000_000_000

function meter(overrides: Partial<LimitsMeter> = {}): LimitsMeter {
  return {
    id: "session",
    labelKey: "subscription.limits.meter.session",
    kind: "window",
    usedPct: 42,
    resetAt: NOW + 90 * 60_000,
    status: "ok",
    ...overrides,
  }
}

describe("WindowGaugeCard", () => {
  it("renders the resolved label, percent, level word, and countdown", () => {
    render(<WindowGaugeCard meter={meter()} now={NOW} testid="gauge" />)
    expect(screen.getByText("Current session")).toBeInTheDocument()
    expect(screen.getByText("42%")).toBeInTheDocument()
    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(screen.getByText("Resets in 1h 30m")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42")
  })

  it("shows the representative badge when flagged", () => {
    render(<WindowGaugeCard meter={meter()} now={NOW} representative />)
    expect(screen.getByText("Representative")).toBeInTheDocument()
  })

  it("renders warn/crit level words with the right emphasis", () => {
    const { rerender } = render(
      <WindowGaugeCard meter={meter({ usedPct: 92, status: "warn" })} now={NOW} />
    )
    expect(screen.getByText("Approaching limit")).toBeInTheDocument()
    rerender(<WindowGaugeCard meter={meter({ usedPct: 104, status: "exceeded" })} now={NOW} />)
    expect(screen.getByText("At limit")).toBeInTheDocument()
    // The headline percent shows the raw value; the bar clamps at 100.
    expect(screen.getByText("104%")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
  })

  it("handles a missing percent, unknown status, and expired reset", () => {
    render(
      <WindowGaugeCard
        meter={meter({ usedPct: null, status: "unknown", resetAt: NOW - 1000 })}
        now={NOW}
      />
    )
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.getByText("Resetting now")).toBeInTheDocument()
  })

  it("falls back to the plain label then the id when no i18n key resolves", () => {
    render(<WindowGaugeCard meter={meter({ labelKey: undefined, label: "Custom" })} now={NOW} />)
    expect(screen.getByText("Custom")).toBeInTheDocument()
    render(
      <WindowGaugeCard
        meter={meter({ labelKey: undefined, label: undefined, id: "xy" })}
        now={NOW}
      />
    )
    expect(screen.getByText("xy")).toBeInTheDocument()
  })

  it("shows reset-unknown when the meter has no reset time", () => {
    render(<WindowGaugeCard meter={meter({ resetAt: null })} now={NOW} />)
    expect(screen.getByText("Reset time unknown")).toBeInTheDocument()
  })
})
