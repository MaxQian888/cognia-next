import { render, screen } from "@testing-library/react"

import { Skeleton } from "./skeleton"

describe("Skeleton", () => {
  it("forwards accessibility props so the caller owns the announcement", () => {
    // The component ships no text of its own — pinned because a placeholder
    // that silently announces nothing is the failure mode we are avoiding.
    render(<Skeleton role="status" aria-label="Loading rows" />)

    const skeleton = screen.getByRole("status", { name: "Loading rows" })
    expect(skeleton).toHaveAttribute("data-slot", "skeleton")
    expect(skeleton.tagName).toBe("DIV")
    expect(skeleton).toBeEmptyDOMElement()
  })

  it("keeps the pulse animation and lets caller sizing through", () => {
    render(<Skeleton role="status" aria-label="Loading" className="h-4 w-32" />)

    const skeleton = screen.getByRole("status")
    expect(skeleton.className).toContain("animate-pulse")
    expect(skeleton.className).toContain("h-4")
    expect(skeleton.className).toContain("w-32")
  })

  it("lets a caller override the radius rather than emitting both", () => {
    render(<Skeleton role="status" aria-label="Loading" className="rounded-full" />)

    const skeleton = screen.getByRole("status")
    // cn() resolved rounded-md vs rounded-full instead of stacking them.
    expect(skeleton.className).toContain("rounded-full")
    expect(skeleton.className).not.toContain("rounded-md")
  })

  it("renders children when a caller composes a shaped placeholder", () => {
    render(
      <Skeleton role="status" aria-label="Loading card">
        <span>inner</span>
      </Skeleton>
    )

    expect(screen.getByText("inner").parentElement).toHaveAttribute("data-slot", "skeleton")
  })
})
