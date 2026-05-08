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
