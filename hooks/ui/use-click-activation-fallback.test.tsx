/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"

import { isPhysicalPointerClick, useClickActivationFallback } from "./use-click-activation-fallback"

function Harness({ activate }: { activate: (() => void) | null }) {
  const handlers = useClickActivationFallback<HTMLButtonElement>(activate)
  return (
    <>
      <button type="button" {...handlers}>
        trigger
      </button>
      <span>elsewhere</span>
    </>
  )
}

/** A click as a platform that dispatches `click` as a `PointerEvent` would. */
function clickWithPointerType(target: Element, pointerType: string) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  target.dispatchEvent(event)
}

/** Run the deferred disarm that follows a gesture's ending event. */
function flushGestureEnd() {
  act(() => {
    jest.runOnlyPendingTimers()
  })
}

describe("isPhysicalPointerClick", () => {
  it("recognises the device pointer types a physical press reports", () => {
    for (const pointerType of ["mouse", "pen", "touch"]) {
      const event = new Event("click")
      Object.defineProperty(event, "pointerType", { value: pointerType })
      expect(isPhysicalPointerClick(event)).toBe(true)
    }
  })

  it("treats programmatic and plain mouse-event clicks as non-pointer", () => {
    const programmatic = new Event("click")
    Object.defineProperty(programmatic, "pointerType", { value: "" })
    expect(isPhysicalPointerClick(programmatic)).toBe(false)
    expect(isPhysicalPointerClick(new MouseEvent("click"))).toBe(false)
  })
})

describe("useClickActivationFallback", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("activates on a bare element.click() (assistive / programmatic activation)", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    screen.getByRole("button", { name: "trigger" }).click()
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it("activates on a plain mousedown/mouseup/click sequence with no pointer events", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    const trigger = screen.getByRole("button", { name: "trigger" })
    fireEvent.mouseDown(trigger)
    fireEvent.mouseUp(trigger)
    fireEvent.click(trigger)
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it("ignores the click that ends a pointer press the trigger already handled", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    const trigger = screen.getByRole("button", { name: "trigger" })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(activate).not.toHaveBeenCalled()
  })

  it("ignores a click the platform marks as a physical press, armed or not", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    const trigger = screen.getByRole("button", { name: "trigger" })
    clickWithPointerType(trigger, "mouse")
    clickWithPointerType(trigger, "touch")
    expect(activate).not.toHaveBeenCalled()
    clickWithPointerType(trigger, "")
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it("disarms when the press's click lands elsewhere (a modal menu took the pointer)", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    const trigger = screen.getByRole("button", { name: "trigger" })
    fireEvent.pointerDown(trigger)
    fireEvent.click(screen.getByText("elsewhere"))
    flushGestureEnd()
    trigger.click()
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it("disarms on pointercancel and on contextmenu", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    const trigger = screen.getByRole("button", { name: "trigger" })

    fireEvent.pointerDown(trigger)
    fireEvent.pointerCancel(trigger)
    trigger.click()
    expect(activate).toHaveBeenCalledTimes(1)

    fireEvent.pointerDown(trigger)
    fireEvent.contextMenu(trigger)
    trigger.click()
    expect(activate).toHaveBeenCalledTimes(2)
  })

  it("does not double-activate a keyboard press that also produces a click", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    const trigger = screen.getByRole("button", { name: "trigger" })
    fireEvent.keyDown(trigger, { key: "Enter" })
    fireEvent.click(trigger)
    expect(activate).not.toHaveBeenCalled()
  })

  it("disarms after the key comes back up, even when focus has moved on", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    const trigger = screen.getByRole("button", { name: "trigger" })
    fireEvent.keyDown(trigger, { key: " " })
    fireEvent.keyUp(document.body, { key: " " })
    flushGestureEnd()
    trigger.click()
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it("does not arm for keys the trigger does not activate on", () => {
    const activate = jest.fn()
    render(<Harness activate={activate} />)
    const trigger = screen.getByRole("button", { name: "trigger" })
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    trigger.click()
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it("respects a caller that prevented the click", () => {
    const activate = jest.fn()
    function Prevented() {
      const handlers = useClickActivationFallback<HTMLButtonElement>(activate)
      return (
        <button
          type="button"
          {...handlers}
          onClick={(event) => {
            event.preventDefault()
            handlers.onClick(event)
          }}
        >
          prevented
        </button>
      )
    }
    render(<Prevented />)
    screen.getByRole("button", { name: "prevented" }).click()
    expect(activate).not.toHaveBeenCalled()
  })

  it("is inert without an activation target", () => {
    render(<Harness activate={null} />)
    expect(() => screen.getByRole("button", { name: "trigger" }).click()).not.toThrow()
  })

  it("removes its document listeners when the trigger unmounts mid-gesture", () => {
    const activate = jest.fn()
    const removeSpy = jest.spyOn(document, "removeEventListener")
    const { unmount } = render(<Harness activate={activate} />)
    fireEvent.pointerDown(screen.getByRole("button", { name: "trigger" }))
    unmount()
    const removed = removeSpy.mock.calls.map(([type]) => type)
    expect(removed).toEqual(expect.arrayContaining(["click", "contextmenu"]))
    removeSpy.mockRestore()
  })
})
