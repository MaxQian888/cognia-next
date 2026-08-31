/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { UsageBudgetMeters } from "./usage-budget-meters"
import type { CostBudgetStatus } from "@/hooks/usage/use-cost-budget-status"

// next-intl is globally mocked against en.json in jest.setup.ts.

const status = jest.fn<CostBudgetStatus, []>()

jest.mock("@/hooks/usage/use-cost-budget-status", () => ({
  useCostBudgetStatus: () => status(),
}))

function state(patch: Partial<CostBudgetStatus>): CostBudgetStatus {
  return {
    policy: {},
    spend: null,
    verdicts: [],
    worst: null,
    loading: false,
    configured: false,
    ...patch,
  }
}

describe("UsageBudgetMeters", () => {
  it("renders nothing when no ceiling exists and no hint was given", () => {
    status.mockReturnValue(state({}))
    const { container } = render(<UsageBudgetMeters />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the caller's hint instead of an empty card when unconfigured", () => {
    status.mockReturnValue(state({}))
    render(<UsageBudgetMeters emptyHint="Set a limit" />)
    expect(screen.getByTestId("usage-budget-unconfigured")).toHaveTextContent("Set a limit")
  })

  it("waits for the spend query rather than claiming zero spend", () => {
    status.mockReturnValue(state({ configured: true, loading: true }))
    render(<UsageBudgetMeters />)
    expect(screen.getByTestId("usage-budget-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("usage-budget-meters")).not.toBeInTheDocument()
  })

  it("labels a global scope by its window and a provider scope by its id", () => {
    status.mockReturnValue(
      state({
        configured: true,
        verdicts: [
          {
            scopeKey: "day:*",
            period: "day",
            target: "*",
            usedUsd: 4,
            limitUsd: 20,
            ratio: 0.2,
            level: "ok",
          },
          {
            scopeKey: "month:anthropic",
            period: "month",
            target: "anthropic",
            usedUsd: 90,
            limitUsd: 100,
            ratio: 0.9,
            level: "warning",
          },
        ],
      })
    )
    render(<UsageBudgetMeters />)
    expect(screen.getByTestId("usage-budget-scope-day:*")).toHaveTextContent("Today, all providers")
    const provider = screen.getByTestId("usage-budget-scope-month:anthropic")
    expect(provider).toHaveTextContent("anthropic")
    expect(provider).toHaveTextContent("$90.00 / $100.00")
  })

  it("caps the bar at its track while the text still reports the overshoot", () => {
    status.mockReturnValue(
      state({
        configured: true,
        verdicts: [
          {
            scopeKey: "day:*",
            period: "day",
            target: "*",
            usedUsd: 26,
            limitUsd: 20,
            ratio: 1.3,
            level: "exceeded",
          },
        ],
      })
    )
    render(<UsageBudgetMeters />)
    expect(screen.getByTestId("usage-budget-scope-day:*")).toHaveTextContent("130.0%")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
  })
})
