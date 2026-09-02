// Strings come from the real `i18n/messages/en.json` through the global
// next-intl mock in `jest.setup.ts`, so these assertions double as a check
// that every key this component builds at runtime actually exists.
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { buildUsageGlance, type UsageGlanceSnapshotV1 } from "@/lib/usage/usage-glance"

import { meterRatio, sparklinePath, TrayPanelUsageSection } from "./tray-panel-usage-section"

function glance(over: Partial<UsageGlanceSnapshotV1> = {}): UsageGlanceSnapshotV1 {
  return {
    ...buildUsageGlance({
      rows: [],
      query: { period: "7d", scope: "cognia", metric: "spend" },
      now: 0,
    }),
    ...over,
  }
}

function renderSection(props: Partial<React.ComponentProps<typeof TrayPanelUsageSection>> = {}) {
  return render(
    <TrayPanelUsageSection
      glance={glance({ knownCostUsd: 4.2, turns: 3 })}
      metric="spend"
      onRefresh={jest.fn()}
      onOpenFull={jest.fn()}
      {...props}
    />
  )
}

describe("meterRatio", () => {
  it("prefers the budget, which is the number with a threshold", () => {
    expect(
      meterRatio(
        glance({
          budget: { ratio: 0.4, target: "*", period: "day", blocked: false },
          quota: { worstUsedPct: 90, worstAccountKey: "a", resetAt: null },
        })
      )
    ).toBeCloseTo(0.4)
  })

  it("clamps an overshoot so the bar cannot run past the track", () => {
    expect(
      meterRatio(glance({ budget: { ratio: 1.8, target: "*", period: "day", blocked: false } }))
    ).toBe(1)
  })

  it("falls back to plan quota", () => {
    expect(
      meterRatio(glance({ quota: { worstUsedPct: 25, worstAccountKey: "a", resetAt: null } }))
    ).toBeCloseTo(0.25)
  })

  it("returns null when neither is configured, so no empty bar is drawn", () => {
    expect(meterRatio(glance())).toBeNull()
  })
})

describe("sparklinePath", () => {
  it("is empty for no points", () => {
    expect(sparklinePath([], 96, 20)).toBe("")
  })

  it("draws a flat line along the baseline when every value is zero", () => {
    // A max of 0 must not divide by zero and must not spike the line to the top.
    expect(sparklinePath([0, 0], 96, 20)).toBe("M0.00,20.00 L96.00,20.00")
  })

  it("puts the maximum at the top of the box", () => {
    expect(sparklinePath([0, 10], 96, 20)).toBe("M0.00,20.00 L96.00,0.00")
  })
})

describe("TrayPanelUsageSection", () => {
  it("renders the headline and its window", () => {
    renderSection()
    expect(screen.getByTestId("usage-headline")).toHaveTextContent("$4.2")
    expect(screen.getByText("Last 7 days")).toBeInTheDocument()
  })

  it("shows a loading line rather than a zero before the projection lands", () => {
    renderSection({ glance: null })
    expect(screen.getByText("Reading usage…")).toBeInTheDocument()
    expect(screen.queryByTestId("usage-headline")).not.toBeInTheDocument()
  })

  it("discloses partial pricing instead of implying a complete total", () => {
    renderSection({ glance: glance({ knownCostUsd: 4.2, turns: 5, unpricedTurns: 2 }) })
    expect(screen.getByTestId("usage-disclosure")).toHaveTextContent("2 turns have no pricing")
  })

  it("says so when nothing could be priced at all", () => {
    renderSection({ glance: glance({ turns: 3, unpricedTurns: 3 }) })
    expect(screen.getByTestId("usage-disclosure")).toHaveTextContent("No pricing")
  })

  it("discloses an incomplete scan even when the pricing is exact", () => {
    renderSection({ glance: glance({ knownCostUsd: 1, turns: 1, freshness: "partial" }) })
    expect(screen.getByTestId("usage-disclosure")).toHaveTextContent("Some tools could not be read")
  })

  it("stays quiet when the answer is complete", () => {
    renderSection({ glance: glance({ knownCostUsd: 1, turns: 1, freshness: "fresh" }) })
    expect(screen.queryByTestId("usage-disclosure")).not.toBeInTheDocument()
  })

  it("omits the meter when no budget or quota is configured", () => {
    renderSection()
    expect(screen.queryByRole("meter")).not.toBeInTheDocument()
  })

  it("renders the meter against the configured budget", () => {
    renderSection({
      glance: glance({
        knownCostUsd: 4,
        turns: 1,
        budget: { ratio: 0.6, target: "*", period: "day", blocked: false },
      }),
    })
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "60")
  })

  it("surfaces the top provider and model", () => {
    renderSection({
      glance: glance({
        knownCostUsd: 4,
        turns: 1,
        topProviders: [{ id: "anthropic", knownCostUsd: 4, tokens: 1, turns: 1, unpricedTurns: 0 }],
        topModels: [{ id: "opus", knownCostUsd: 4, tokens: 1, turns: 1, unpricedTurns: 0 }],
      }),
    })
    expect(screen.getByText("anthropic")).toBeInTheDocument()
    expect(screen.getByText("opus")).toBeInTheDocument()
  })

  it("fires the two actions", async () => {
    const onRefresh = jest.fn()
    const onOpenFull = jest.fn()
    renderSection({ onRefresh, onOpenFull })
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await userEvent.click(screen.getByRole("button", { name: "Open full usage" }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onOpenFull).toHaveBeenCalledTimes(1)
  })

  it("disables Refresh while a scan is running", () => {
    renderSection({ refreshing: true })
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
  })
})
