/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ProviderSkeleton } from "./provider-skeleton"

jest.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}))

describe("ProviderSkeleton", () => {
  it("renders placeholders for the loading state", () => {
    render(<ProviderSkeleton />)
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(5)
  })

  // The point of a skeleton is that the page keeps its shape once real data
  // lands. This one used to draw a single column of stacked cards — the shape of
  // an older layout — so hydration visibly reflowed the whole pane. These
  // assertions pin it to the grid `provider-settings.tsx` actually renders.
  it("uses the same 320px rail + detail grid as the real pane", () => {
    const { container } = render(<ProviderSkeleton />)
    const grid = container.querySelector(".grid")
    expect(grid).not.toBeNull()
    expect(grid!.className).toContain("md:grid-cols-[320px_1fr]")
    expect(grid!.className).toContain("grid-cols-1")
  })

  it("hides the rail below md, matching where the real list moves into a Sheet", () => {
    const { container } = render(<ProviderSkeleton />)
    const rail = container.querySelector(".hidden")
    expect(rail).not.toBeNull()
    expect(rail!.className).toContain("md:flex")
  })

  it("stands in a compact bar for the mobile Sheet trigger", () => {
    const { container } = render(<ProviderSkeleton />)
    expect(container.querySelector(".md\\:hidden")).not.toBeNull()
  })

  it("keeps the outer frame min-h-0 so the inner columns can scroll", () => {
    const { container } = render(<ProviderSkeleton />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain("min-h-0")
    expect(root.className).toContain("h-full")
  })
})
