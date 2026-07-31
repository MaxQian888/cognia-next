/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { DonutPanel } from "./donut-panel"
import { panelById } from "./panel-registry"
import type { BreakdownRow } from "@/lib/observability/breakdown"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function row(key: string, spans: number, over: Partial<BreakdownRow> = {}): BreakdownRow {
  return {
    key,
    spans,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    errors: 0,
    avgLatencyMs: 0,
    ...over,
  }
}

describe("DonutPanel", () => {
  it("renders chart + legend for rows", () => {
    render(<DonutPanel panel={panelById("bd-model")!} rows={[row("opus", 5), row("sonnet", 2)]} />)
    expect(screen.getByTestId("donut-chart-bd-model")).toBeInTheDocument()
    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getAllByTestId("donut-legend-bd-model")).toHaveLength(2)
  })

  it("shows an empty hint with no rows", () => {
    render(<DonutPanel panel={panelById("bd-model")!} rows={[]} />)
    expect(screen.getByText("noData")).toBeInTheDocument()
  })

  it("renders static legend rows (no buttons) when non-interactive", () => {
    render(<DonutPanel panel={panelById("bd-model")!} rows={[row("opus", 5)]} />)
    expect(screen.queryByTestId("donut-legend-bd-model-opus")).not.toBeInTheDocument()
  })

  it("toggles a filter value when a legend entry is clicked", () => {
    const onSelectValue = jest.fn()
    render(
      <DonutPanel
        panel={panelById("bd-model")!}
        rows={[row("opus", 5), row("sonnet", 2)]}
        onSelectValue={onSelectValue}
        selectedValues={["opus"]}
      />
    )
    const selected = screen.getByTestId("donut-legend-bd-model-opus")
    expect(selected).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByTestId("donut-legend-bd-model-sonnet"))
    expect(onSelectValue).toHaveBeenCalledWith("sonnet")
  })

  it("switches the measure and re-ranks by it", () => {
    render(
      <DonutPanel
        panel={panelById("bd-model")!}
        rows={[row("cheap", 9, { costUsd: 1 }), row("pricey", 1, { costUsd: 50 })]}
        onSelectValue={jest.fn()}
      />
    )
    // spans default → "cheap" first
    fireEvent.click(screen.getByTestId("metric-toggle-bd-model-cost"))
    // cost measure → "pricey" shows its USD value
    expect(screen.getByTestId("donut-legend-bd-model-pricey")).toHaveTextContent("$50.00")
  })
})
