import { render, screen } from "@testing-library/react"

import { RUNTIME_BAND_ACTION, RuntimeStatusBand } from "./runtime-status-band"

describe("<RuntimeStatusBand />", () => {
  it("reads as one sentence: state, then what it means here", () => {
    render(<RuntimeStatusBand tone="progress" title="Reconnecting" detail="cached data only" />)
    const band = screen.getByTestId("runtime-status-band")
    expect(band).toHaveTextContent("Reconnecting · cached data only")
    expect(band).toHaveAttribute("data-tone", "progress")
  })

  it("omits the separator when there is nothing to add to the state", () => {
    render(<RuntimeStatusBand tone="offline" title="Host offline" />)
    expect(screen.getByTestId("runtime-status-band")).toHaveTextContent(/^Host offline$/)
    expect(screen.queryByTestId("runtime-status-band-detail")).not.toBeInTheDocument()
  })

  it("only spins the icon while something is actually in progress", () => {
    const { container, rerender } = render(<RuntimeStatusBand tone="progress" title="x" />)
    expect(container.querySelector("svg")).toHaveClass("animate-spin")
    rerender(<RuntimeStatusBand tone="attention" title="x" />)
    expect(container.querySelector("svg")).not.toHaveClass("animate-spin")
  })

  it("paints a problem detail as one", () => {
    render(<RuntimeStatusBand tone="attention" title="Queue" detail="2 refused" detailAttention />)
    expect(screen.getByTestId("runtime-status-band-detail")).toHaveClass("text-destructive")
  })

  it("renders trailing actions", () => {
    render(
      <RuntimeStatusBand
        tone="offline"
        title="Host offline"
        actions={
          <button type="button" className={RUNTIME_BAND_ACTION}>
            Settings
          </button>
        }
      />
    )
    expect(screen.getByRole("button", { name: "Settings" })).toHaveClass("touch-hit")
  })
})
