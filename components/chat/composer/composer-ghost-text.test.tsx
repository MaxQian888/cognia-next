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

  it("forwards the inner ref for scroll syncing", () => {
    const ref = { current: null as HTMLDivElement | null }
    render(<ComposerGhostText ref={ref} value="x" ghost=" y" />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it("shows the manual-tier hint even with no ghost", () => {
    render(<ComposerGhostText value="x" ghost="" manualHint="Alt+\ ask the agent" />)
    expect(screen.getByTestId("composer-ghost-manual")).toHaveTextContent("Alt+\\ ask the agent")
  })

  it("takes the code font when the skin puts the textarea in it", () => {
    // Same alignment contract as the chip overlay: a proportional ghost over a
    // monospace textarea drifts further with every character typed.
    const { rerender } = render(<ComposerGhostText value="hello" ghost=" world" mono />)
    expect(screen.getByTestId("composer-ghost-text").firstElementChild).toHaveClass("font-mono")
    rerender(<ComposerGhostText value="hello" ghost=" world" />)
    expect(screen.getByTestId("composer-ghost-text").firstElementChild).not.toHaveClass("font-mono")
  })

  describe("caret mode", () => {
    // With the floating suggestion card owning the text + badges, the inline
    // layer keeps only a pulse marker where the suggestion anchors.

    it("paints a live caret even with no ghost text", () => {
      render(<ComposerGhostText value="hello" ghost="" caret />)
      const overlay = screen.getByTestId("composer-ghost-text")
      expect(overlay).toBeInTheDocument()
      expect(overlay).toHaveTextContent("hello")
      // The caret is a styled span, not text — nothing follows the value.
      expect(overlay.textContent).toBe("hello")
    })

    it("does not paint the ghost text itself — the card owns it", () => {
      render(<ComposerGhostText value="hello" ghost=" world" caret />)
      const overlay = screen.getByTestId("composer-ghost-text")
      expect(overlay.textContent).toBe("hello")
      expect(overlay.textContent).not.toContain("world")
    })

    it("still shows the manual-tier hint in caret mode", () => {
      render(<ComposerGhostText value="x" ghost="" caret manualHint="Alt+\ ask the agent" />)
      expect(screen.getByTestId("composer-ghost-manual")).toHaveTextContent("Alt+\\ ask the agent")
    })
  })
})
