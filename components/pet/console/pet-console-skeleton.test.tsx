import { render, screen } from "@testing-library/react"
import { PetConsoleSkeleton, PetTabSkeleton } from "./pet-console-skeleton"

describe("PetConsoleSkeleton", () => {
  it("announces loading once, as a busy status region", () => {
    render(<PetConsoleSkeleton />)
    const region = screen.getByTestId("pet-console-loading")
    expect(region).toHaveAttribute("role", "status")
    expect(region).toHaveAttribute("aria-busy", "true")
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(region).toHaveTextContent(/waking up your pet|console\.loading/i)
    // The blocks themselves are decorative.
    expect(
      region.querySelectorAll('[data-slot="skeleton"][aria-hidden="true"]').length
    ).toBeGreaterThan(5)
  })
})

describe("PetTabSkeleton", () => {
  it.each(["list", "grid", "report"] as const)("draws the %s shape", (variant) => {
    render(<PetTabSkeleton variant={variant} count={3} testId="tab-loading" />)
    const region = screen.getByTestId("tab-loading")
    expect(region).toHaveAttribute("data-skeleton", variant)
    expect(region).toHaveAttribute("aria-busy", "true")
    expect(region.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it.each([
    ["list", 4],
    ["grid", 7],
    ["report", 3],
  ] as const)("draws one %s placeholder per requested item (%i)", (variant, count) => {
    render(<PetTabSkeleton variant={variant} count={count} testId="tab-loading" />)
    expect(screen.getByTestId("tab-loading").querySelectorAll("[data-skeleton-item]")).toHaveLength(
      count
    )
  })

  it("defaults to six list rows", () => {
    render(<PetTabSkeleton testId="tab-loading" />)
    const region = screen.getByTestId("tab-loading")
    expect(region).toHaveAttribute("data-skeleton", "list")
    expect(region.querySelectorAll("[data-skeleton-item]")).toHaveLength(6)
  })
})
