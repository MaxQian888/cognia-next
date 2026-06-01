import { render, screen } from "@testing-library/react"
import { TerminalGhostText } from "./terminal-ghost-text"

describe("TerminalGhostText", () => {
  it("renders the ghost suffix at the given position", () => {
    render(
      <TerminalGhostText ghost="status" left={40} top={12} fontFamily="monospace" fontSize={14} />
    )
    const el = screen.getByTestId("terminal-ghost-text")
    expect(el).toHaveTextContent("status")
    expect(el).toHaveStyle({ left: "40px", top: "12px" })
  })

  it("renders nothing when the ghost is empty", () => {
    const { container } = render(
      <TerminalGhostText ghost="" left={0} top={0} fontFamily="monospace" fontSize={14} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the accept hint badge when provided", () => {
    render(
      <TerminalGhostText
        ghost="status"
        left={0}
        top={0}
        fontFamily="monospace"
        fontSize={14}
        acceptHint="Tab"
        source="ai"
      />
    )
    expect(screen.getByText("Tab")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-ghost-text")).toHaveAttribute("data-source", "ai")
  })

  it("hides the badge when no hint is given", () => {
    render(<TerminalGhostText ghost="x" left={0} top={0} fontFamily="monospace" fontSize={14} />)
    // Only the ghost span — no badge text node.
    expect(screen.getByTestId("terminal-ghost-text").querySelectorAll("span")).toHaveLength(1)
  })
})
