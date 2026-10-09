/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { useState } from "react"

import { ParkedView, ParkedViewSlot, useParkedViewTarget } from "./parked-view"

function Counter() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
      {count}
    </button>
  )
}

function Host({ shown }: { shown: boolean }) {
  const target = useParkedViewTarget()
  return (
    <>
      <ParkedView target={target}>
        <Counter />
      </ParkedView>
      {shown ? <ParkedViewSlot target={target} testId="slot" /> : null}
    </>
  )
}

describe("parked view", () => {
  it("creates one detached target for the component's lifetime", () => {
    const { result, rerender } = renderHook(() => useParkedViewTarget())
    const first = result.current
    expect(first).toBeInstanceOf(HTMLElement)
    expect(first?.isConnected).toBe(false)
    rerender()
    expect(result.current).toBe(first)
  })

  it("shows the view inside the slot and keeps its state while the slot is gone", () => {
    const { rerender } = render(<Host shown />)
    const slot = screen.getByTestId("slot")
    expect(slot).toContainElement(screen.getByTestId("counter"))

    fireEvent.click(screen.getByTestId("counter"))
    fireEvent.click(screen.getByTestId("counter"))
    expect(screen.getByTestId("counter")).toHaveTextContent("2")

    // The slot unmounts (the sidebar folds): the view leaves the document…
    rerender(<Host shown={false} />)
    expect(screen.queryByTestId("counter")).toBeNull()

    // …and comes back with its state when a slot adopts it again.
    rerender(<Host shown />)
    expect(screen.getByTestId("slot")).toContainElement(screen.getByTestId("counter"))
    expect(screen.getByTestId("counter")).toHaveTextContent("2")
  })

  it("leaves the target alone when another slot already adopted it", () => {
    function Two({ second }: { second: boolean }) {
      const target = useParkedViewTarget()
      return (
        <>
          <ParkedView target={target}>
            <span data-testid="view">view</span>
          </ParkedView>
          {second ? null : <ParkedViewSlot target={target} testId="a" />}
          {second ? <ParkedViewSlot target={target} testId="b" /> : null}
        </>
      )
    }
    const { rerender } = render(<Two second={false} />)
    act(() => rerender(<Two second />))
    expect(screen.getByTestId("b")).toContainElement(screen.getByTestId("view"))
  })
})
