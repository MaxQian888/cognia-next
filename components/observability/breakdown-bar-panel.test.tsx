/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { BreakdownBarPanel } from "./breakdown-bar-panel"
import { panelById } from "./panel-registry"
import type { BreakdownRow } from "@/lib/observability/breakdown"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string) => key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

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

  it("renders a visible legend list — no sr-only click targets", () => {
    render(
      <BreakdownBarPanel
        panel={panelById("bd-surface")!}
        rows={[row("chat", 3)]}
        onSelectValue={jest.fn()}
      />
    )
    const toggle = screen.getByTestId("bar-select-bd-surface-chat")
    expect(toggle.closest(".sr-only")).toBeNull()
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("list", { name: "panels.bySurface" })).toBeInTheDocument()
  })

  it("marks selected values pressed", () => {
    render(
      <BreakdownBarPanel
        panel={panelById("bd-surface")!}
        rows={[row("chat", 3)]}
        onSelectValue={jest.fn()}
        selectedValues={["chat"]}
      />
    )
    expect(screen.getByTestId("bar-select-bd-surface-chat")).toHaveAttribute("aria-pressed", "true")
  })

  it("drills into Explore from a row's Show traces", () => {
    const onShowTraces = jest.fn()
    render(
      <BreakdownBarPanel
        panel={panelById("bd-surface")!}
        rows={[row("chat", 3)]}
        onShowTraces={onShowTraces}
      />
    )
    fireEvent.click(screen.getByTestId("bar-select-bd-surface-show-chat"))
    expect(onShowTraces).toHaveBeenCalledWith("chat")
  })

  it("hides the drill in edit mode", () => {
    render(
      <BreakdownBarPanel
        panel={panelById("bd-surface")!}
        rows={[row("chat", 3)]}
        onShowTraces={jest.fn()}
        editMode
      />
    )
    expect(screen.queryByTestId("bar-select-bd-surface-show-chat")).not.toBeInTheDocument()
  })
})
