/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { BreakdownBarPanel } from "./breakdown-bar-panel"
import { panelById } from "./panel-registry"
import type { BreakdownRow } from "@/lib/observability/breakdown"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function row(key: string, spans: number): BreakdownRow {
  return { key, spans, costUsd: 0, inputTokens: 0, outputTokens: 0, errors: 0, avgLatencyMs: 0 }
}

describe("BreakdownBarPanel", () => {
  it("renders the chart when there are rows", () => {
    render(
      <BreakdownBarPanel
        panel={panelById("bd-surface")!}
        rows={[row("chat", 3), row("workflow", 1)]}
      />
    )
    expect(screen.getByTestId("bar-chart-bd-surface")).toBeInTheDocument()
  })

  it("shows an empty hint with no rows", () => {
    render(<BreakdownBarPanel panel={panelById("bd-surface")!} rows={[]} />)
    expect(screen.getByText("noData")).toBeInTheDocument()
    expect(screen.queryByTestId("bar-chart-bd-surface")).not.toBeInTheDocument()
  })
})
