/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { MonthForecast } from "@/lib/usage/usage-insights"
import { UsageForecastPanel, UsageForecastView } from "./usage-forecast-panel"

const DAY = 86_400_000
const NOW = new Date(2026, 4, 20, 12).getTime()
const MONTH_START = new Date(2026, 4, 1).getTime()
const MONTH_END = new Date(2026, 5, 1).getTime()

const hookState: { forecast: MonthForecast | null } = { forecast: null }
jest.mock("@/hooks/usage/use-month-forecast", () => ({
  useMonthForecast: () => ({ forecast: hookState.forecast, now: NOW }),
}))
const settings: { costBudget?: { monthlyUsd?: number } } = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ settings }),
}))

function forecast(over: Partial<MonthForecast> = {}): MonthForecast {
  return {
    monthToDateUsd: 40,
    turns: 100,
    unpricedTurns: 0,
    dailyRunRateUsd: 2,
    projectedMonthUsd: 40 + 2 * ((MONTH_END - NOW) / DAY),
    basis: "trailing-7d",
    rateWindowDays: 6.5,
    monthStart: MONTH_START,
    monthEnd: MONTH_END,
    ...over,
  }
}

describe("UsageForecastView", () => {
  it("shows month to date, run rate and projection with its basis", () => {
    render(<UsageForecastView forecast={forecast()} now={NOW} />)
    expect(screen.getByTestId("usage-forecast-mtd")).toHaveTextContent("$40.00")
    expect(screen.getByTestId("usage-forecast-rate")).toHaveTextContent("$2.00/day")
    expect(screen.getByTestId("usage-forecast-projected")).toHaveTextContent("$63.00")
    expect(screen.getByTestId("usage-forecast-basis")).toHaveTextContent(
      "Run rate from the last 7 days."
    )
    expect(screen.queryByTestId("usage-forecast-limit")).toBeNull()
  })

  it("says when the run rate crosses the monthly limit", () => {
    render(<UsageForecastView forecast={forecast()} now={NOW} monthlyLimitUsd={50} />)
    expect(screen.getByTestId("usage-forecast-limit")).toBeInTheDocument()
    expect(screen.getByTestId("usage-forecast-limit-line")).toHaveTextContent(
      /At this pace you reach the \$50.00 monthly limit around/
    )
  })

  it("says how much of the limit the month should use when it stays within it", () => {
    render(<UsageForecastView forecast={forecast()} now={NOW} monthlyLimitUsd={100} />)
    expect(screen.getByTestId("usage-forecast-limit-line")).toHaveTextContent(
      "At this pace the month ends at 63% of the $100.00 limit."
    )
  })

  it("reports an already exceeded limit", () => {
    render(<UsageForecastView forecast={forecast()} now={NOW} monthlyLimitUsd={30} />)
    expect(screen.getByTestId("usage-forecast-limit-line")).toHaveTextContent(
      "This month has already passed the $30.00 limit."
    )
  })

  it("renders dashes and the reason when there is not enough history", () => {
    render(
      <UsageForecastView
        forecast={forecast({ dailyRunRateUsd: null, projectedMonthUsd: null, basis: null })}
        now={NOW}
      />
    )
    expect(screen.getByTestId("usage-forecast-rate")).toHaveTextContent("—")
    expect(screen.getByTestId("usage-forecast-projected")).toHaveTextContent("—")
    expect(screen.getByTestId("usage-forecast-basis")).toHaveTextContent(
      "A projection needs at least one full day of history."
    )
  })

  it("marks every figure as a lower bound when turns could not be priced", () => {
    render(<UsageForecastView forecast={forecast({ unpricedTurns: 3 })} now={NOW} />)
    expect(screen.getByTestId("usage-forecast-mtd")).toHaveTextContent("≥ $40.00")
    expect(screen.getByTestId("usage-forecast-projected")).toHaveTextContent("≥ $63.00")
    expect(screen.getByTestId("usage-forecast-basis")).toHaveTextContent(
      "3 turns this month could not be priced"
    )
  })
})

describe("UsageForecastPanel", () => {
  beforeEach(() => {
    hookState.forecast = null
    delete settings.costBudget
  })

  it("renders nothing until the read answers", () => {
    const { container } = render(<UsageForecastPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it("measures the projection against the configured monthly ceiling", () => {
    hookState.forecast = forecast()
    settings.costBudget = { monthlyUsd: 100 }
    render(<UsageForecastPanel />)
    expect(screen.getByTestId("usage-forecast-limit")).toBeInTheDocument()
  })
})
