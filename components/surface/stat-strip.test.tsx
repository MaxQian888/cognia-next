import { render, screen } from "@testing-library/react"

import { StatStrip, type StatStripItem } from "./stat-strip"

const stat = (id: string, extra: Partial<StatStripItem> = {}): StatStripItem => ({
  id,
  label: id,
  value: 1,
  ...extra,
})

describe("StatStrip", () => {
  it("renders one cell per stat, with the label already translated", () => {
    render(<StatStrip stats={[stat("caps", { label: "Capabilities", value: 4, total: 20 })]} />)
    expect(screen.getByTestId("stat-caps")).toBeInTheDocument()
    expect(screen.getByText("Capabilities")).toBeInTheDocument()
    expect(screen.getByText("4")).toBeInTheDocument()
    expect(screen.getByText("/20")).toBeInTheDocument()
  })

  it("omits the denominator when a stat is a plain count", () => {
    const { container } = render(<StatStrip stats={[stat("runs", { value: 3 })]} />)
    expect(container.textContent).not.toContain("/")
  })

  /**
   * A fixed four-column grid leaves an empty tile, which reads as a value that
   * failed to load rather than a stat the subject cannot answer.
   */
  it("takes as many columns as there are stats, never four with a hole", () => {
    const { rerender } = render(<StatStrip stats={[stat("a"), stat("b")]} />)
    expect(screen.getByTestId("stat-strip").className).toContain("grid-cols-2")

    rerender(<StatStrip stats={[stat("a"), stat("b"), stat("c")]} />)
    expect(screen.getByTestId("stat-strip").className).toContain("@lg/console-pane:grid-cols-3")
  })

  /**
   * The responsive step has to name the pane. An interpolated container name
   * emits no class at all, so the strip would simply stop reflowing.
   */
  it("reflows against whichever pane owns it", () => {
    render(<StatStrip stats={[stat("a"), stat("b"), stat("c")]} pane="device-pane" />)
    expect(screen.getByTestId("stat-strip").className).toContain("@lg/device-pane:grid-cols-3")
  })

  it("renders nothing when there is nothing to report", () => {
    const { container } = render(<StatStrip stats={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("honours caller-supplied test ids so an existing console keeps its hooks", () => {
    render(
      <StatStrip stats={[stat("caps")]} testId="device-stat-strip" cellTestIdPrefix="device-stat" />
    )
    expect(screen.getByTestId("device-stat-strip")).toBeInTheDocument()
    expect(screen.getByTestId("device-stat-caps")).toBeInTheDocument()
  })

  it("tints a stat that wants attention", () => {
    render(<StatStrip stats={[stat("caps", { value: 2, tone: "attention" })]} />)
    expect(screen.getByText("2").className).toContain("text-amber-600")
  })
})
