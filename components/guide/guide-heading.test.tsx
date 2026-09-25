/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { GuideHeading } from "./guide-heading"

describe("GuideHeading", () => {
  it("is the page's h1", () => {
    render(<GuideHeading title="Find your desktop" />)
    expect(screen.getByRole("heading", { level: 1, name: "Find your desktop" })).toBeInTheDocument()
  })

  it("renders no description paragraph when none is given", () => {
    const { container } = render(<GuideHeading title="Scan" />)
    expect(container.querySelectorAll("p")).toHaveLength(0)
  })

  it("sets every step title at one size, with muted supporting copy", () => {
    render(<GuideHeading title="Scan" description="what we found" />)
    expect(screen.getByRole("heading")).toHaveClass("text-2xl")
    expect(screen.getByText("what we found")).toHaveClass("text-muted-foreground")
  })

  it("gives the intro screen a hero size whose lede reads as body copy", () => {
    render(<GuideHeading size="hero" title="Welcome" description="lede" />)
    expect(screen.getByRole("heading")).toHaveClass("text-4xl", "sm:text-5xl")
    expect(screen.getByText("lede")).toHaveClass("text-foreground")
  })
})
