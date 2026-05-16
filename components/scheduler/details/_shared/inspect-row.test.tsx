/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { InspectRow } from "./inspect-row"

describe("InspectRow", () => {
  it("renders a 2-column label/value row when compareValue is omitted", () => {
    const { container } = render(<InspectRow label="Cron" value="0 9 * * *" />)
    expect(screen.getByText("Cron")).toBeInTheDocument()
    expect(screen.getByText("0 9 * * *")).toBeInTheDocument()
    // 2-column grid: fixed-width label column + flexible value column so long
    // values get the rest of the row instead of being capped at 2/3 width.
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain("grid-cols-[minmax(120px,180px)_1fr]")
  })

  it("renders a placeholder dash when value is an empty string", () => {
    render(<InspectRow label="Last run" value="" />)
    expect(screen.getByText("-")).toBeInTheDocument()
  })

  it("renders a ReactNode value verbatim (no fallback dash for non-string)", () => {
    render(<InspectRow label="Status" value={<span data-testid="custom-value">custom</span>} />)
    expect(screen.getByTestId("custom-value")).toBeInTheDocument()
  })

  it("renders a 3-column comparison row when compareValue is provided", () => {
    const { container } = render(
      <InspectRow label="Trigger" value="cron: 0 2 * * *" compareValue="cron: 0 2 * * *" />
    )
    expect(screen.getByText("Trigger")).toBeInTheDocument()
    const matches = screen.getAllByText("cron: 0 2 * * *")
    expect(matches).toHaveLength(2)
    // 3-column grid: label + value + compareValue
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain("grid-cols-[1fr_1fr_1fr]")
  })

  it("highlights mismatched values in amber when value !== compareValue and both are non-empty", () => {
    render(<InspectRow label="Status" value="ready" compareValue="degraded" />)
    const valueCell = screen.getByText("ready")
    const compareCell = screen.getByText("degraded")
    expect(valueCell.className).toContain("text-amber-600")
    expect(compareCell.className).toContain("text-amber-600")
  })

  it("does NOT highlight when one side is empty (treated as 'no data', not mismatch)", () => {
    render(<InspectRow label="Last run" value="2026-05-11" compareValue="" />)
    const valueCell = screen.getByText("2026-05-11")
    expect(valueCell.className).not.toContain("text-amber-600")
  })

  it("falls back to '-' for empty string in either column of the comparison row", () => {
    render(<InspectRow label="Next run" value="" compareValue="" />)
    const dashes = screen.getAllByText("-")
    expect(dashes).toHaveLength(2)
  })
})
