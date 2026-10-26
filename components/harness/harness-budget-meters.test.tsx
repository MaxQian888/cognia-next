/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { emptyLedger, DEFAULT_HARNESS_BUDGET } from "@/lib/harness/budget"
import { HarnessBudgetMeters } from "./harness-budget-meters"

describe("HarnessBudgetMeters", () => {
  it("shows each ceiling's use, marking an unpriced cost as a lower bound", () => {
    const ledger = {
      ...emptyLedger(),
      costUsd: 1.25,
      costUnknown: true,
      inputTokens: 1500,
      outputTokens: 500,
      modelCalls: 7,
      rollouts: 3,
      sessions: 2,
    }
    render(
      <HarnessBudgetMeters
        ledger={ledger}
        budget={DEFAULT_HARNESS_BUDGET}
        startedAt={0}
        now={60_000}
      />
    )
    const meters = screen.getByTestId("harness-budget-meters")
    expect(meters.querySelector('[data-dimension="cost"]')).toHaveTextContent("$1.25+ of $5.00")
    expect(meters.querySelector('[data-dimension="tokens"]')).toHaveTextContent("2.0K of 4.00M")
    expect(meters.querySelector('[data-dimension="modelCalls"]')).toHaveTextContent("7 of 40")
    expect(meters.querySelector('[data-dimension="wallTime"]')).toHaveTextContent("1.0m of 120.0m")
    expect(screen.getByText(/lower bound/)).toBeInTheDocument()
    expect(
      screen.getByText("3 rollouts and 2 editor or judge sessions finished.")
    ).toBeInTheDocument()
  })
})
