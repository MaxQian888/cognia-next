import { render, screen } from "@testing-library/react"
import { ComposerGhostText } from "./composer-ghost-text"

describe("ComposerGhostText", () => {
  it("renders nothing when there is no ghost", () => {
    const { container } = render(<ComposerGhostText value="hello" ghost="" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("paints the dim ghost suffix after a transparent copy of the value", () => {
    render(<ComposerGhostText value="hello" ghost=" world" />)
    const overlay = screen.getByTestId("composer-ghost-text")
    expect(overlay.firstElementChild).toHaveClass("min-h-9")
    expect(overlay).toHaveAttribute("data-ghost", " world")
    expect(overlay).toHaveTextContent("hello world")
    expect(overlay).toHaveAttribute("aria-hidden", "true")
  })

  it("shows the accept hint badge when provided", () => {
    render(<ComposerGhostText value="x" ghost=" more" acceptHint="Tab" />)
    expect(screen.getByText("Tab")).toBeInTheDocument()
  })

  it("omits the accept hint when not provided", () => {
    render(<ComposerGhostText value="x" ghost=" more" />)
    expect(screen.queryByText("Tab")).not.toBeInTheDocument()
  })

  it("forwards the inner ref for scroll syncing", () => {
    const ref = { current: null as HTMLDivElement | null }
    render(<ComposerGhostText ref={ref} value="x" ghost=" y" />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it("names the suggestion's source so a free history hit is not mistaken for a model guess", () => {
    render(<ComposerGhostText value="x" ghost=" more" sourceLabel="history" />)
    const overlay = screen.getByTestId("composer-ghost-text")
    expect(screen.getByTestId("composer-ghost-source")).toHaveTextContent("history")
    expect(overlay).toHaveAttribute("data-ghost-source", "history")
  })

  it("omits the source badge when no label is given", () => {
    render(<ComposerGhostText value="x" ghost=" more" />)
    expect(screen.queryByTestId("composer-ghost-source")).not.toBeInTheDocument()
  })

  it("shows the candidate position and cycle hint", () => {
    render(
      <ComposerGhostText value="x" ghost=" more" positionLabel="1/3" cycleHint="Alt+] to cycle" />
    )
    expect(screen.getByTestId("composer-ghost-position")).toHaveTextContent("1/3")
    expect(screen.getByTestId("composer-ghost-cycle")).toHaveTextContent("Alt+] to cycle")
  })

  it("omits the position and cycle affordances when not provided", () => {
    render(<ComposerGhostText value="x" ghost=" more" />)
    expect(screen.queryByTestId("composer-ghost-position")).not.toBeInTheDocument()
    expect(screen.queryByTestId("composer-ghost-cycle")).not.toBeInTheDocument()
  })

  it("takes the code font when the skin puts the textarea in it", () => {
    // Same alignment contract as the chip overlay: a proportional ghost over a
    // monospace textarea drifts further with every character typed.
    const { rerender } = render(<ComposerGhostText value="hello" ghost=" world" mono />)
    expect(screen.getByTestId("composer-ghost-text").firstElementChild).toHaveClass("font-mono")
    rerender(<ComposerGhostText value="hello" ghost=" world" />)
    expect(screen.getByTestId("composer-ghost-text").firstElementChild).not.toHaveClass("font-mono")
  })
})
