import { render, screen } from "@testing-library/react"
import { AppFrame, PaneHeading } from "./app-frame"

describe("AppFrame", () => {
  it("names the project the reconstruction is showing", () => {
    render(
      <AppFrame title="acme/checkout-service" label="Interface reconstruction">
        body
      </AppFrame>
    )
    expect(screen.getByText("acme/checkout-service")).toBeInTheDocument()
  })

  it("always carries the reconstruction marker, so no frame reads as a screenshot", () => {
    render(
      <AppFrame title="acme/checkout-service" label="Interface reconstruction">
        body
      </AppFrame>
    )
    expect(screen.getByText("Interface reconstruction")).toBeInTheDocument()
  })

  it("renders the meta line when given", () => {
    render(
      <AppFrame title="repo" meta="Branch release/2.4.0" label="reconstruction">
        body
      </AppFrame>
    )
    expect(screen.getByText("Branch release/2.4.0")).toBeInTheDocument()
  })

  it("omits the meta line when not given, rather than leaving an empty slot", () => {
    const { container } = render(
      <AppFrame title="repo" label="reconstruction">
        body
      </AppFrame>
    )
    expect(container.querySelectorAll("p")).toHaveLength(2)
  })

  it("renders its children", () => {
    render(
      <AppFrame title="repo" label="reconstruction">
        <span>pane content</span>
      </AppFrame>
    )
    expect(screen.getByText("pane content")).toBeInTheDocument()
  })

  it("uses the light product surface by default", () => {
    const { container } = render(
      <AppFrame title="repo" label="reconstruction">
        body
      </AppFrame>
    )
    expect(container.querySelector('[data-reconstruction="frame"]')).toHaveClass("bg-surface")
  })

  it("uses the dark execution substrate when asked", () => {
    const { container } = render(
      <AppFrame title="repo" label="reconstruction" tone="stage">
        body
      </AppFrame>
    )
    expect(container.querySelector('[data-reconstruction="frame"]')).toHaveClass("bg-stage")
  })

  it("passes a layout class through", () => {
    const { container } = render(
      <AppFrame title="repo" label="reconstruction" className="my-class">
        body
      </AppFrame>
    )
    expect(container.querySelector(".my-class")).toBeInTheDocument()
  })
})

describe("PaneHeading", () => {
  it("renders its label", () => {
    render(<PaneHeading>Thread</PaneHeading>)
    expect(screen.getByText("Thread")).toBeInTheDocument()
  })

  it("switches to the on-stage token on the dark substrate", () => {
    const { container } = render(<PaneHeading tone="stage">Terminal</PaneHeading>)
    expect(container.firstChild).toHaveClass("text-on-stage-muted")
  })

  it("uses the paper-layer muted token by default", () => {
    const { container } = render(<PaneHeading>Thread</PaneHeading>)
    expect(container.firstChild).toHaveClass("text-muted")
  })

  it("passes a layout class through", () => {
    const { container } = render(<PaneHeading className="mb-2">Thread</PaneHeading>)
    expect(container.querySelector(".mb-2")).toBeInTheDocument()
  })
})
