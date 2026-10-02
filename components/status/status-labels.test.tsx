import { render, renderHook, screen } from "@testing-library/react"

import {
  ConfidenceBadge,
  IconTile,
  PanelEmpty,
  StatusPanel,
  LEGEND_ORDER,
  MonitoringLabel,
  SectionHeading,
  STATUS_STYLES,
  StatusLabel,
  usePercentLabel,
} from "./status-labels"

describe("status labels", () => {
  it("labels every status with text, not colour alone", () => {
    render(<StatusLabel status="major_outage" />)
    expect(screen.getByText("Major outage")).toHaveAttribute("data-status", "major_outage")
  })

  it("gives unknown its own neutral style, distinct from operational", () => {
    expect(STATUS_STYLES.unknown.dot).not.toBe(STATUS_STYLES.operational.dot)
    expect(STATUS_STYLES.unknown.text).toBe("text-muted-foreground")
    expect(LEGEND_ORDER).toContain("unknown")
    expect(LEGEND_ORDER).toContain("no_data")
  })

  it("marks a stale reading as not current and drops its colour", () => {
    render(<StatusLabel status="operational" stale />)
    const label = screen.getByText("Operational · not current")
    expect(label).toHaveAttribute("data-stale", "true")
    expect(label.className).not.toMatch(/emerald/)
  })

  it("explains confidence levels", () => {
    render(<ConfidenceBadge confidence="single_witness" />)
    expect(screen.getByText("Single observer")).toHaveAttribute(
      "title",
      expect.stringContaining("not independently confirmed")
    )
  })

  it("adds a single-observer badge to limited monitoring", () => {
    const { rerender } = render(<MonitoringLabel status="limited" />)
    expect(screen.getByText("Limited")).toBeInTheDocument()
    expect(screen.getByText("Single observer")).toBeInTheDocument()
    rerender(<MonitoringLabel status="healthy" />)
    expect(screen.queryByText("Single observer")).toBeNull()
  })

  it("formats a percentage and never turns missing data into a number", () => {
    const { result } = renderHook(() => usePercentLabel())
    expect(result.current(99.999)).toBe("99.99%")
    expect(result.current(null)).toBe("No data")
  })

  it("renders a section heading with an anchorable id", () => {
    render(<SectionHeading id="x" icon={() => null} title="Title" description="Text" />)
    expect(screen.getByRole("heading", { name: "Title" })).toHaveAttribute("id", "x")
    expect(screen.getByText("Text")).toBeInTheDocument()
  })

  it("draws a pill label with the status tint and keeps the text", () => {
    render(<StatusLabel status="degraded" pill />)
    const label = screen.getByText("Degraded")
    expect(label.className).toMatch(/rounded-full/)
    expect(label.className).toContain(STATUS_STYLES.degraded.soft.split(" ")[0])
  })

  it("renders a panel, a decorative icon tile and an empty state", () => {
    render(
      <StatusPanel data-testid="panel">
        <PanelEmpty icon={() => null} tone="success" title="Nothing here" description="Why" />
      </StatusPanel>
    )
    expect(screen.getByTestId("panel").className).toMatch(/rounded-2xl/)
    expect(screen.getByText("Nothing here")).toBeInTheDocument()
    expect(screen.getByText("Why")).toBeInTheDocument()
    const tile = document.querySelector('[data-tone="success"]')
    expect(tile).toHaveAttribute("aria-hidden", "true")
  })

  it("sizes icon tiles", () => {
    render(<IconTile icon={() => null} size="lg" tone="danger" />)
    const tile = document.querySelector('[data-tone="danger"]')
    expect(tile?.className).toMatch(/size-12/)
  })

  it("renders a heading action beside the title", () => {
    render(<SectionHeading icon={() => null} title="T" action={<button>Act</button>} />)
    expect(screen.getByRole("button", { name: "Act" })).toBeInTheDocument()
  })
})
