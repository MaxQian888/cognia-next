/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
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

  it("exposes accessible click targets that toggle the filter", () => {
    const onSelectValue = jest.fn()
    render(
      <BreakdownBarPanel
        panel={panelById("bd-surface")!}
        rows={[row("chat", 3), row("workflow", 1)]}
        onSelectValue={onSelectValue}
      />
    )
    fireEvent.click(screen.getByTestId("bar-select-bd-surface-chat"))
    expect(onSelectValue).toHaveBeenCalledWith("chat")
  })

  it("has no select buttons when non-interactive", () => {
    render(<BreakdownBarPanel panel={panelById("bd-surface")!} rows={[row("chat", 3)]} />)
    expect(screen.queryByTestId("bar-select-bd-surface-chat")).not.toBeInTheDocument()
  })

  it("switches the measure", () => {
    render(<BreakdownBarPanel panel={panelById("bd-surface")!} rows={[row("chat", 3)]} />)
    fireEvent.click(screen.getByTestId("metric-toggle-bd-surface-errors"))
    expect(screen.getByTestId("metric-toggle-bd-surface-errors")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })
})
