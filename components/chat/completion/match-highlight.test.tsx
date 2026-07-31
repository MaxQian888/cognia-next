import { render, screen } from "@testing-library/react"
import { MatchHighlight } from "./match-highlight"

describe("MatchHighlight", () => {
  it("renders plain text with no marks for empty positions", () => {
    const { container } = render(<MatchHighlight text="git/commit" positions={[]} />)
    expect(container.querySelector("mark")).toBeNull()
    expect(container.textContent).toBe("git/commit")
  })

  it("emphasizes exactly the given positions", () => {
    const { container } = render(<MatchHighlight text="git/commit" positions={[0, 4]} />)
    const marks = container.querySelectorAll("mark")
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(["g", "c"])
    // Full text is still present and ordered.
    expect(container.textContent).toBe("git/commit")
  })

  it("coalesces consecutive matched characters into one mark", () => {
    const { container } = render(<MatchHighlight text="model" positions={[0, 1, 2]} />)
    const marks = container.querySelectorAll("mark")
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe("mod")
  })

  it("ignores out-of-range positions", () => {
    const { container } = render(<MatchHighlight text="abc" positions={[-1, 99, 1]} />)
    const marks = container.querySelectorAll("mark")
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(["b"])
    expect(container.textContent).toBe("abc")
  })

  it("applies wrapper and mark class names", () => {
    render(<MatchHighlight text="cost" positions={[0]} className="wrap-x" markClassName="mark-x" />)
    const mark = screen.getByText("c")
    expect(mark.className).toContain("mark-x")
    expect(mark.closest("span")?.className).toContain("wrap-x")
  })
})
