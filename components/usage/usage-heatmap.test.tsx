/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { DailyUsage } from "@/types/system/usage"
import { costLevel, levelStyle, UsageHeatmap } from "./usage-heatmap"

// next-intl is globally mocked against en.json in jest.setup.ts.

const NOW = new Date(2026, 4, 20, 12).getTime()
const DAY_MS = 86_400_000

/** Local "YYYY-MM-DD" key, matching the component's own day bucketing. */
function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`
}

function daily(entries: Partial<DailyUsage>[]): DailyUsage[] {
  return entries.map((e) => ({
    date: e.date ?? dayKey(NOW),
    tokens: 0,
    cost: 0,
    requests: 0,
    ...e,
  }))
}

describe("costLevel", () => {
  it("reserves level 0 for days with no spend", () => {
    expect(costLevel(0, 10)).toBe(0)
    expect(costLevel(-1, 10)).toBe(0)
  })

  it("puts any spend into 1–4, scaled against the busiest day", () => {
    expect(costLevel(10, 10)).toBe(4)
    expect(costLevel(5, 10)).toBe(2)
    expect(costLevel(0.001, 10)).toBe(1)
  })

  it("falls back to level 1 when the range has no positive maximum", () => {
    expect(costLevel(5, 0)).toBe(1)
  })

  it("never exceeds the graph's maxLevel", () => {
    expect(costLevel(100, 10)).toBe(4)
  })
})

describe("levelStyle", () => {
  it("leaves level 0 to the primitive's themed default", () => {
    expect(levelStyle(0, "#abc123")).toBeUndefined()
  })

  it("tints higher levels more strongly with the palette accent", () => {
    const one = levelStyle(1, "#abc123")
    const four = levelStyle(4, "#abc123")
    expect(one?.fill).toBe("#abc123")
    expect(Number(four?.fillOpacity)).toBeGreaterThan(Number(one?.fillOpacity))
  })
})

describe("<UsageHeatmap />", () => {
  it("renders one cell per day in the window, padding days with no usage", () => {
    render(<UsageHeatmap daily={daily([{ cost: 1, requests: 2 }])} rangeDays={7} now={NOW} />)
    expect(screen.getAllByTestId(/^usage-cost-heatmap-cell-/)).toHaveLength(7)
    expect(screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW)}`)).toBeInTheDocument()
    expect(
      screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW - 6 * DAY_MS)}`)
    ).toBeInTheDocument()
  })

  it("widens the grid to the requested range", () => {
    render(<UsageHeatmap daily={daily([])} rangeDays={30} now={NOW} />)
    expect(screen.getAllByTestId(/^usage-cost-heatmap-cell-/)).toHaveLength(30)
  })

  it("tints only the days that carry spend", () => {
    render(
      <UsageHeatmap
        daily={daily([{ date: dayKey(NOW), cost: 4, requests: 3 }])}
        rangeDays={7}
        now={NOW}
      />
    )
    expect(screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW)}`)).toHaveAttribute("style")
    expect(
      screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW - DAY_MS)}`)
    ).not.toHaveAttribute("style")
  })

  it("labels each cell with its date, cost and request count", () => {
    render(
      <UsageHeatmap
        daily={daily([{ date: dayKey(NOW), cost: 1.5, requests: 4 }])}
        rangeDays={7}
        now={NOW}
      />
    )
    const cell = screen.getByTestId(`usage-cost-heatmap-cell-${dayKey(NOW)}`)
    expect(cell.getAttribute("aria-label")).toContain("$1.50")
    expect(cell.getAttribute("aria-label")).toContain("4")
    // Focusable so the tooltip is reachable without a pointer.
    expect(cell).toHaveAttribute("tabindex", "0")
  })

  it("totals the whole window in the footer", () => {
    render(
      <UsageHeatmap
        daily={daily([
          { date: dayKey(NOW), cost: 1, requests: 2 },
          { date: dayKey(NOW - DAY_MS), cost: 2, requests: 3 },
        ])}
        rangeDays={7}
        now={NOW}
      />
    )
    expect(screen.getByTestId("usage-cost-heatmap-total").textContent).toContain("$3.00")
  })

  it("namespaces its test ids so two surfaces can render side by side", () => {
    render(<UsageHeatmap daily={daily([])} rangeDays={7} now={NOW} testIdPrefix="welcome-heat" />)
    expect(screen.getByTestId("welcome-heat")).toBeInTheDocument()
    expect(screen.getAllByTestId(/^welcome-heat-cell-/)).toHaveLength(7)
    expect(screen.queryByTestId("usage-cost-heatmap")).not.toBeInTheDocument()
  })
})
