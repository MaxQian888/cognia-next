import { render, screen } from "@testing-library/react"
import { NeedBar } from "./need-bar"

describe("NeedBar", () => {
  it("renders the label and the rounded value with the need-kind marker", () => {
    render(<NeedBar kind="energy" value={63.4} label="Energy" />)
    expect(document.querySelector('[data-need="energy"]')).not.toBeNull()
    expect(screen.getByText("Energy")).toBeInTheDocument()
    expect(screen.getByText("63")).toBeInTheDocument()
  })

  it("uses semantic threshold styles for warning and destructive values", () => {
    const { rerender } = render(<NeedBar kind="mood" value={80} label="Mood" />)
    expect(screen.getByRole("progressbar")).not.toHaveClass(
      "[&>[data-slot=progress-indicator]]:bg-destructive"
    )
    rerender(<NeedBar kind="mood" value={40} label="Mood" />)
    expect(screen.getByRole("progressbar")).toHaveClass(
      "[&>[data-slot=progress-indicator]]:bg-muted-foreground"
    )
    rerender(<NeedBar kind="mood" value={10} label="Mood" />)
    expect(screen.getByRole("progressbar")).toHaveClass(
      "[&>[data-slot=progress-indicator]]:bg-destructive"
    )
  })

  it("exposes the rounded percentage through the shadcn progress primitive", () => {
    render(<NeedBar kind="bond" value={49.6} label="Bond" />)
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50")
  })
})
