/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ProviderSkeleton } from "./provider-skeleton"

// Mock UI components
jest.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}))

jest.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>
      {children}
    </div>
  ),
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-content">{children}</div>
  ),
  CardHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-header">{children}</div>
  ),
}))

describe("ProviderSkeleton", () => {
  it("renders without crashing", () => {
    render(<ProviderSkeleton />)
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0)
  })

  it("renders multiple skeleton elements for loading state", () => {
    render(<ProviderSkeleton />)
    const skeletons = screen.getAllByTestId("skeleton")
    expect(skeletons.length).toBeGreaterThan(5)
  })

  it("renders card containers", () => {
    render(<ProviderSkeleton />)
    const cards = screen.getAllByTestId("card")
    expect(cards.length).toBeGreaterThan(0)
  })

  it("renders 4 card containers (1 quick overview + 3 provider cards)", () => {
    render(<ProviderSkeleton />)
    const cards = screen.getAllByTestId("card")
    expect(cards.length).toBe(4)
  })
})
