/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { UnreadPill } from "./unread-pill"

describe("UnreadPill", () => {
  it("renders nothing when count is 0", () => {
    const { container } = render(<UnreadPill count={0} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when count is negative", () => {
    const { container } = render(<UnreadPill count={-1} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the count when count > 0", () => {
    render(<UnreadPill count={3} />)
    expect(screen.getByTestId("unread-pill")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("caps display at 99+ for counts > 99", () => {
    render(<UnreadPill count={150} />)
    expect(screen.getByText("99+")).toBeInTheDocument()
  })

  it("shows exact count for 99", () => {
    render(<UnreadPill count={99} />)
    expect(screen.getByText("99")).toBeInTheDocument()
  })

  it("has aria-label indicating the unread count", () => {
    render(<UnreadPill count={5} />)
    expect(screen.getByLabelText("5 unread")).toBeInTheDocument()
  })

  it("uses the shadcn Badge primitive (destructive variant)", () => {
    render(<UnreadPill count={2} />)
    const pill = screen.getByTestId("unread-pill")
    expect(pill).toHaveAttribute("data-slot", "badge")
    expect(pill).toHaveAttribute("data-variant", "destructive")
  })

  it("merges a custom className", () => {
    render(<UnreadPill count={1} className="custom-extra" />)
    expect(screen.getByTestId("unread-pill")).toHaveClass("custom-extra")
  })
})
