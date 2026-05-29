/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { DonutPanel } from "./donut-panel"
import { panelById } from "./panel-registry"
import type { BreakdownRow } from "@/lib/observability/breakdown"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function row(key: string, spans: number): BreakdownRow {
  return { key, spans, costUsd: 0, inputTokens: 0, outputTokens: 0, errors: 0, avgLatencyMs: 0 }
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
})
