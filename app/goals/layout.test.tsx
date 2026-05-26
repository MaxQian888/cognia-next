import { render, screen } from "@testing-library/react"
import GoalsLayout, { metadata } from "./layout"

describe("GoalsLayout", () => {
  it("renders its children", () => {
    render(<GoalsLayout>{<div data-testid="child">hi</div>}</GoalsLayout>)
    expect(screen.getByTestId("child")).toBeInTheDocument()
  })

  it("exports a page title", () => {
    expect(metadata.title).toMatch(/Goals/)
  })
})
