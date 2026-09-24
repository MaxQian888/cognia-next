/**
 * @jest-environment jsdom
 */
import "./test-pointer-polyfill"
import { fireEvent, render, screen } from "@testing-library/react"
import { act } from "react"

import { LongPress } from "./long-press"

jest.useFakeTimers()

describe("<LongPress />", () => {
  it("fires onLongPress after hold delay", () => {
    const onLongPress = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it("does not fire if pointer is released before delay", () => {
    const onLongPress = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 })
    fireEvent.pointerUp(btn)
    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("cancels when pointer moves past tolerance", () => {
    const onLongPress = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent tolerancePx={10}>
        <button>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(btn, { clientX: 50, clientY: 0 })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("ignores small movements within tolerance", () => {
    const onLongPress = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent tolerancePx={10}>
        <button>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(btn, { clientX: 5, clientY: 5 })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(onLongPress).toHaveBeenCalled()
  })

  it("cancels on pointer cancel / leave", () => {
    const onLongPress = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 })
    fireEvent.pointerCancel(btn)
    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("swallows the click that ends a fired press, so the row is not also opened", () => {
    const onLongPress = jest.fn()
    const onClick = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button onClick={onClick}>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    fireEvent.pointerUp(btn)
    fireEvent.click(btn)
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("lets an ordinary tap through, including the one after a consumed press", () => {
    const onLongPress = jest.fn()
    const onClick = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button onClick={onClick}>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    fireEvent.pointerUp(btn)
    fireEvent.click(btn)
    // Next, a short tap.
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 })
    fireEvent.pointerUp(btn)
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("suppresses the platform context menu raised by the same held touch", () => {
    const onLongPress = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0, pointerType: "touch" })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    const notCancelled = fireEvent.contextMenu(btn)
    expect(notCancelled).toBe(false)
  })

  it("does not time a secondary mouse button as a hold", () => {
    const onLongPress = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button>row</button>
      </LongPress>
    )
    fireEvent.pointerDown(screen.getByText("row"), {
      clientX: 0,
      clientY: 0,
      button: 2,
      pointerType: "mouse",
    })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("never swallows a keyboard activation", () => {
    const onLongPress = jest.fn()
    const onClick = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button onClick={onClick}>row</button>
      </LongPress>
    )
    const btn = screen.getByText("row")
    // A touch press fired, and the browser never sent the trailing click.
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0, pointerType: "touch" })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    fireEvent.pointerUp(btn)
    fireEvent.keyDown(btn, { key: "Enter" })
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("forwards original pointer handlers", () => {
    const onPointerDown = jest.fn()
    const onLongPress = jest.fn()
    render(
      <LongPress onLongPress={onLongPress} silent>
        <button onPointerDown={onPointerDown}>row</button>
      </LongPress>
    )
    fireEvent.pointerDown(screen.getByText("row"), { clientX: 0, clientY: 0 })
    expect(onPointerDown).toHaveBeenCalled()
  })
})
