/**
 * @jest-environment jsdom
 */
import "./test-pointer-polyfill"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SwipeRow, type SwipeAction } from "./swipe-row"

const ACTIONS: SwipeAction[] = [
  { id: "delete", label: "Delete", destructive: true, onSelect: jest.fn() },
  { id: "mute", label: "Mute", onSelect: jest.fn() },
]

beforeEach(() => {
  ACTIONS.forEach((a) => (a.onSelect as jest.Mock).mockReset())
})

function dragForeground(el: HTMLElement, dx: number) {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 0, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 100 + dx, clientY: 0, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: 100 + dx, clientY: 0, pointerId: 1 })
}

describe("<SwipeRow />", () => {
  it("renders foreground content", () => {
    render(
      <SwipeRow rightActions={ACTIONS} silent>
        <div>session row</div>
      </SwipeRow>
    )
    expect(screen.getByText("session row")).toBeInTheDocument()
  })

  it("snaps open after dragging past commit threshold", () => {
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>session row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    // 2 actions × 72 = 144 px. Drag -100 to commit (> 72 = 50% of 144).
    dragForeground(fg, -100)
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "right")
  })

  it("snaps closed when drag does not pass threshold", () => {
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>session row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    dragForeground(fg, -30)
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "closed")
  })

  it("invokes the action onSelect when its button is clicked", async () => {
    const user = userEvent.setup()
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>session row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    dragForeground(fg, -100)
    await user.click(screen.getByTestId("swipe-action-delete"))
    expect(ACTIONS[0].onSelect).toHaveBeenCalled()
  })

  it("closes after invoking an action", async () => {
    const user = userEvent.setup()
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>session row</div>
      </SwipeRow>
    )
    dragForeground(screen.getByTestId("swipe-row-foreground"), -100)
    await user.click(screen.getByTestId("swipe-action-delete"))
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "closed")
  })

  it("supports left actions on right-drag", () => {
    render(
      <SwipeRow leftActions={ACTIONS} actionWidth={72} silent>
        <div>row</div>
      </SwipeRow>
    )
    dragForeground(screen.getByTestId("swipe-row-foreground"), 100)
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "left")
  })

  it("marks itself for the drawer edge-swipe to leave alone", () => {
    render(
      <SwipeRow rightActions={ACTIONS} silent>
        <div>row</div>
      </SwipeRow>
    )
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-swipe-row")
  })

  it("keeps a closed strip out of the tab order and the accessibility tree", () => {
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>row</div>
      </SwipeRow>
    )
    const strip = screen.getByTestId("swipe-row-right-actions")
    expect(strip).toHaveAttribute("inert")
    expect(strip).toHaveAttribute("aria-hidden", "true")
    expect(screen.getByTestId("swipe-action-delete")).toHaveAttribute("tabindex", "-1")

    dragForeground(screen.getByTestId("swipe-row-foreground"), -100)
    expect(strip).not.toHaveAttribute("inert")
    expect(strip).toHaveAttribute("aria-hidden", "false")
    expect(screen.getByTestId("swipe-action-delete")).not.toHaveAttribute("tabindex")
  })

  it("does not move for jitter inside the slop", () => {
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    fireEvent.pointerDown(fg, { clientX: 100, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(fg, { clientX: 94, clientY: 0, pointerId: 1 })
    expect(fg.style.transform).toBe("translateX(0px)")
  })

  it("abandons a press that turns into a vertical scroll", () => {
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    fireEvent.pointerDown(fg, { clientX: 100, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(fg, { clientX: 102, clientY: 40, pointerId: 1 })
    // The scroll continues sideways; the row must not pick it up.
    fireEvent.pointerMove(fg, { clientX: -60, clientY: 60, pointerId: 1 })
    fireEvent.pointerUp(fg, { clientX: -60, clientY: 60, pointerId: 1 })
    expect(fg.style.transform).toBe("translateX(0px)")
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "closed")
  })

  it("captures the pointer once a drag starts, so a mouse released outside still ends it", () => {
    const capture = jest.spyOn(Element.prototype, "setPointerCapture")
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    // A plain press does not capture: capturing on pointerdown would retarget
    // the click and the row underneath could never be tapped.
    fireEvent.pointerDown(fg, { clientX: 100, clientY: 0, pointerId: 7 })
    expect(capture).not.toHaveBeenCalled()
    fireEvent.pointerMove(fg, { clientX: 20, clientY: 0, pointerId: 7 })
    expect(capture).toHaveBeenCalledWith(7)
    capture.mockRestore()
  })

  it("ends the drag if capture is lost mid-gesture", () => {
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    fireEvent.pointerDown(fg, { clientX: 100, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(fg, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent(fg, new Event("lostpointercapture", { bubbles: true }))
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "right")
    // Further movement no longer drags the row.
    fireEvent.pointerMove(fg, { clientX: 200, clientY: 0, pointerId: 1 })
    expect(fg.style.transform).toBe("translateX(-144px)")
  })

  it("does not let a drag double as a click on the row", () => {
    const onClick = jest.fn()
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <button onClick={onClick}>row</button>
      </SwipeRow>
    )
    const button = screen.getByText("row")
    fireEvent.pointerDown(button, { clientX: 100, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(button, { clientX: 70, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(button, { clientX: 70, clientY: 0, pointerId: 1 })
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    // The next, genuine tap goes through.
    fireEvent.pointerDown(button, { clientX: 100, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(button, { clientX: 100, clientY: 0, pointerId: 1 })
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("closes an open row on a tap instead of activating what is under it", () => {
    const onClick = jest.fn()
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <button onClick={onClick}>row</button>
      </SwipeRow>
    )
    const button = screen.getByText("row")
    dragForeground(button, -100)
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "right")
    fireEvent.pointerDown(button, { clientX: 50, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(button, { clientX: 50, clientY: 0, pointerId: 1 })
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "closed")
  })

  it("closes when a press lands outside the row", () => {
    render(
      <div>
        <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
          <div>row</div>
        </SwipeRow>
        <p>elsewhere</p>
      </div>
    )
    dragForeground(screen.getByTestId("swipe-row-foreground"), -100)
    fireEvent.pointerDown(screen.getByText("elsewhere"))
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "closed")
  })

  it("never starts a drag from a secondary mouse button", () => {
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    fireEvent.pointerDown(fg, { clientX: 100, clientY: 0, button: 2, pointerType: "mouse" })
    fireEvent.pointerMove(fg, { clientX: 0, clientY: 0 })
    fireEvent.pointerUp(fg, { clientX: 0, clientY: 0 })
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "closed")
  })

  it("clamps drag distance to total action width", () => {
    render(
      <SwipeRow rightActions={ACTIONS} actionWidth={72} silent>
        <div>row</div>
      </SwipeRow>
    )
    const fg = screen.getByTestId("swipe-row-foreground")
    dragForeground(fg, -500)
    // After release, snap to -144 (2 * 72) — open right.
    expect(screen.getByTestId("swipe-row")).toHaveAttribute("data-open", "right")
  })
})
