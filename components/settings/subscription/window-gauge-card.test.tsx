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

  it("states a week-scale reset as a weekday and time, not a 3-digit hour count", () => {
    // The weekly / opus / sonnet gauges reset days out. "Resets in 167h 30m" is
    // arithmetic the reader has to redo; this is the one surface that was still
    // printing it after the Overview meters and the /usage card moved on.
    render(
      <WindowGaugeCard
        meter={meter({ id: "weekly", resetAt: NOW + 7 * 24 * 60 * 60_000 })}
        now={NOW}
        testid="gauge-weekly"
      />
    )
    expect(screen.queryByText(/Resets in \d+h/)).not.toBeInTheDocument()
    expect(screen.getByText(/^Resets /)).toBeInTheDocument()
  })

  it("shows the representative badge when flagged", () => {
    render(<WindowGaugeCard meter={meter()} now={NOW} representative />)
    expect(screen.getByText("Representative")).toBeInTheDocument()
  })

  it("renders warn/crit level words with the right emphasis", async () => {
    const { rerender } = render(
      <WindowGaugeCard meter={meter({ usedPct: 92, status: "warn" })} now={NOW} />
    )
    expect(screen.getByText("Approaching limit")).toBeInTheDocument()
    rerender(<WindowGaugeCard meter={meter({ usedPct: 104, status: "exceeded" })} now={NOW} />)
    expect(screen.getByText("At limit")).toBeInTheDocument()
    // The headline percent shows the raw value; the bar clamps at 100. The
    // number now tweens to a changed target (matching the bar, which always
    // animated), so settle before asserting the final figure.
    expect(await screen.findByText("104%")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
  })

  // A tween on first paint would mean every gauge counts up from 0 on mount,
  // which reads as a loading animation rather than a value change.
  it("shows the value immediately on mount without counting up from zero", () => {
    render(<WindowGaugeCard meter={meter({ usedPct: 73, status: "warn" })} now={NOW} />)
    expect(screen.getByText("73%")).toBeInTheDocument()
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
