import { render, renderHook, screen } from "@testing-library/react"

import {
  ConfidenceBadge,
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
})
