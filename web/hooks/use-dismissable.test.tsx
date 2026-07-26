import { fireEvent, render, screen } from "@testing-library/react"
import { useDismissable } from "./use-dismissable"

function Harness() {
  const { open, toggle, close, containerRef, triggerRef } = useDismissable<HTMLDivElement>()
  return (
    <div>
      <button ref={triggerRef} onClick={toggle} type="button">
        Trigger
      </button>
      {open ? (
        <div ref={containerRef} data-testid="panel">
          <button onClick={close} type="button">
            Inside
          </button>
        </div>
      ) : null}
      <button type="button">Outside</button>
    </div>
  )
}

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Trigger" }))
}

describe("useDismissable", () => {
  it("starts closed", () => {
    render(<Harness />)
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument()
  })

  it("toggles open and shut from the trigger", () => {
    render(<Harness />)
    openPanel()
    expect(screen.getByTestId("panel")).toBeInTheDocument()
    openPanel()
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument()
  })

  it("closes on Escape", () => {
    render(<Harness />)
    openPanel()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument()
  })

  it("ignores other keys", () => {
    render(<Harness />)
    openPanel()
    fireEvent.keyDown(document, { key: "a" })
    expect(screen.getByTestId("panel")).toBeInTheDocument()
  })

  it("closes when a pointer press lands outside", () => {
    render(<Harness />)
    openPanel()
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }))
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument()
  })

  it("stays open when the press lands inside the panel", () => {
    render(<Harness />)
    openPanel()
    fireEvent.pointerDown(screen.getByRole("button", { name: "Inside" }))
    expect(screen.getByTestId("panel")).toBeInTheDocument()
  })

  it("stays open when the press lands on the trigger, which handles its own click", () => {
    render(<Harness />)
    openPanel()
    fireEvent.pointerDown(screen.getByRole("button", { name: "Trigger" }))
    expect(screen.getByTestId("panel")).toBeInTheDocument()
  })

  it("returns focus to the trigger after a dismissal", () => {
    render(<Harness />)
    openPanel()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.getByRole("button", { name: "Trigger" })).toHaveFocus()
  })

  it("does not grab focus on the initial render", () => {
    render(<Harness />)
    expect(screen.getByRole("button", { name: "Trigger" })).not.toHaveFocus()
  })

  it("closes from the panel's own control", () => {
    render(<Harness />)
    openPanel()
    fireEvent.click(screen.getByRole("button", { name: "Inside" }))
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument()
  })
})
