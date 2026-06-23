import { render, screen } from "@testing-library/react"
import { NeedBar } from "./need-bar"

/** The fill is the inner of the two divs inside the [data-need] row. */
function fillOf(kind: string): HTMLElement {
  const row = document.querySelector(`[data-need="${kind}"]`)!
  return row.querySelectorAll("div")[1] as HTMLElement
}

describe("NeedBar", () => {
  it("renders the label and the rounded value with the need-kind marker", () => {
    render(<NeedBar kind="energy" value={63.4} label="Energy" />)
    expect(document.querySelector('[data-need="energy"]')).not.toBeNull()
    expect(screen.getByText("Energy")).toBeInTheDocument()
    expect(screen.getByText("63")).toBeInTheDocument()
  })

  it("colors the fill by threshold (primary ≥50, amber <50, destructive <25)", () => {
    const { rerender } = render(<NeedBar kind="mood" value={80} label="Mood" />)
    expect(fillOf("mood").className).toContain("bg-primary")
    rerender(<NeedBar kind="mood" value={40} label="Mood" />)
    expect(fillOf("mood").className).toContain("bg-amber-400")
    rerender(<NeedBar kind="mood" value={10} label="Mood" />)
    expect(fillOf("mood").className).toContain("bg-destructive")
  })

  it("sets the fill width to the rounded percentage", () => {
    render(<NeedBar kind="bond" value={49.6} label="Bond" />)
    expect(fillOf("bond").style.width).toBe("50%")
  })
})
