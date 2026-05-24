/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { JsonTree } from "./json-tree"

describe("JsonTree", () => {
  it("renders a string primitive", () => {
    render(<JsonTree value="hello" />)
    expect(screen.getByText('"hello"')).toBeInTheDocument()
  })

  it("renders a number primitive", () => {
    render(<JsonTree value={42} />)
    expect(screen.getByText("42")).toBeInTheDocument()
  })

  it("renders a boolean primitive", () => {
    render(<JsonTree value={true} />)
    expect(screen.getByText("true")).toBeInTheDocument()
  })

  it("renders null", () => {
    render(<JsonTree value={null} />)
    expect(screen.getByText("null")).toBeInTheDocument()
  })

  it("renders a flat object with collapsible", () => {
    render(<JsonTree value={{ key: "value", num: 42 }} />)
    expect(screen.getByText(/keys/)).toBeInTheDocument()
  })

  it("renders an array with item count", () => {
    render(<JsonTree value={[1, 2, 3]} />)
    expect(screen.getByText(/items/)).toBeInTheDocument()
  })

  it("renders a nested object", () => {
    render(<JsonTree value={{ outer: { inner: "val" } }} />)
    // Should show both outer and inner objects
    expect(screen.getAllByText(/keys/)).toHaveLength(2)
  })
})
