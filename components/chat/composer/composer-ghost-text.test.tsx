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
})
