/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { OTHER_SERIES_KEY, type DailyStack } from "@/lib/usage/usage-insights"
import { UsageStackedCostChart } from "./usage-stacked-cost-chart"

jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({
    "chart-1": "#111",
    "chart-2": "#222",
    "chart-3": "#333",
    "chart-4": "#444",
    "chart-5": "#555",
  }),
}))

const stack: DailyStack = {
  keys: ["claude-opus", "gpt-4.1", OTHER_SERIES_KEY],
  days: [
    {
      date: "2026-05-19",
      values: { "claude-opus": 1, "gpt-4.1": 0.5, [OTHER_SERIES_KEY]: 0.1 },
      total: 1.6,
    },
    {
      date: "2026-05-20",
      values: { "claude-opus": 2, "gpt-4.1": 0, [OTHER_SERIES_KEY]: 0 },
      total: 2,
    },
  ],
}

describe("UsageStackedCostChart", () => {
  it("renders a legend entry per series with the other bucket localized", () => {
    render(<UsageStackedCostChart stack={stack} labelFor={(k) => `label:${k}`} reduce />)
    const legend = screen.getByTestId("usage-stacked-chart-legend")
    const items = legend.querySelectorAll("li")
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent("label:claude-opus")
    expect(items[1]).toHaveTextContent("label:gpt-4.1")
    expect(items[2]).toHaveTextContent("Other")
    expect(items[0].querySelector("span")).toHaveStyle({ backgroundColor: "#111" })
  })
})
