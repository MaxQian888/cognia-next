import { render, screen } from "@testing-library/react"

import { ListSkeleton } from "./list-skeleton"

describe("ListSkeleton", () => {
  it("renders the default number of placeholder rows", () => {
    const { container } = render(<ListSkeleton />)
    const status = screen.getByTestId("discover-list-skeleton")
    expect(status).toHaveAttribute("aria-busy", "true")
    // 4 rows × (1 media + 2 text) = 12 skeleton blocks.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(12)
  })

  it("honors a custom row count and className", () => {
    const { container } = render(<ListSkeleton rows={2} className="mt-4" />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(6)
    expect(screen.getByTestId("discover-list-skeleton")).toHaveClass("mt-4")
  })
})
