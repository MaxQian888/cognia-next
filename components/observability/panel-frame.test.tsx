/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { PanelFrame } from "./panel-frame"

describe("PanelFrame", () => {
  it("renders the title and children", () => {
    render(
      <PanelFrame title="Cost">
        <div>body</div>
      </PanelFrame>
    )
    expect(screen.getByText("Cost")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
  })

  it("hides the drag handle when not in edit mode", () => {
    render(<PanelFrame title="x">c</PanelFrame>)
    expect(screen.queryByTestId("panel-drag-handle")).not.toBeInTheDocument()
  })

  it("shows the drag handle in edit mode", () => {
    render(
      <PanelFrame title="x" editMode>
        c
      </PanelFrame>
    )
    expect(screen.getByTestId("panel-drag-handle")).toBeInTheDocument()
  })

  it("renders a threshold dot with its level", () => {
    render(
      <PanelFrame title="x" level="crit">
        c
      </PanelFrame>
    )
    const dot = screen.getByTestId("panel-threshold-dot")
    expect(dot).toHaveAttribute("data-level", "crit")
  })

  it("renders the actions slot", () => {
    render(
      <PanelFrame title="x" actions={<button>act</button>}>
        c
      </PanelFrame>
    )
    expect(screen.getByRole("button", { name: "act" })).toBeInTheDocument()
  })
})
