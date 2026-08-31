/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { resolvePressTarget, useCanvasLongPress } from "./use-canvas-long-press"

jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn() }))

function Harness({
  onLongPress,
  enabled = true,
}: {
  onLongPress: (t: unknown) => void
  enabled?: boolean
}) {
  const handlers = useCanvasLongPress({ onLongPress, silent: true, enabled })
  return (
    <div data-testid="canvas" {...handlers}>
      <div className="react-flow__node" data-id="n1" data-testid="node" />
      <div className="react-flow__edge" data-id="e1" data-testid="edge" />
    </div>
  )
}

function press(testid: string) {
  fireEvent.pointerDown(screen.getByTestId(testid), {
    clientX: 10,
    clientY: 10,
    isPrimary: true,
  })
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe("resolvePressTarget", () => {
  it("reads the id React Flow stamps on a node wrapper", () => {
    const el = document.createElement("div")
    el.className = "react-flow__node"
    el.dataset.id = "n1"
    expect(resolvePressTarget(el)).toEqual({ kind: "node", id: "n1" })
  })

  it("falls back to the pane for anything else", () => {
    expect(resolvePressTarget(document.createElement("div"))).toEqual({ kind: "pane" })
    expect(resolvePressTarget(null)).toEqual({ kind: "pane" })
  })
})

describe("useCanvasLongPress", () => {
  it("reports which element was held", () => {
    const onLongPress = jest.fn()
    render(<Harness onLongPress={onLongPress} />)
    press("node")
    jest.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledWith({ kind: "node", id: "n1" })
  })

  it("distinguishes an edge from empty canvas", () => {
    const onLongPress = jest.fn()
    render(<Harness onLongPress={onLongPress} />)
    press("edge")
    jest.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledWith({ kind: "edge", id: "e1" })

    onLongPress.mockClear()
    press("canvas")
    jest.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledWith({ kind: "pane" })
  })

  it("cancels once the finger moves, because that is a pan or a drag", () => {
    const onLongPress = jest.fn()
    render(<Harness onLongPress={onLongPress} />)
    press("node")
    fireEvent.pointerMove(screen.getByTestId("canvas"), { clientX: 60, clientY: 10 })
    jest.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("does not fire on a lifted finger", () => {
    const onLongPress = jest.fn()
    render(<Harness onLongPress={onLongPress} />)
    press("node")
    fireEvent.pointerUp(screen.getByTestId("canvas"))
    jest.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("ignores a second finger, which is a pinch", () => {
    const onLongPress = jest.fn()
    render(<Harness onLongPress={onLongPress} />)
    fireEvent.pointerDown(screen.getByTestId("node"), { clientX: 10, clientY: 10, isPrimary: false })
    jest.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("stays quiet while disabled, so read mode never pops a sheet", () => {
    const onLongPress = jest.fn()
    render(<Harness onLongPress={onLongPress} enabled={false} />)
    press("node")
    jest.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })
})
