import { act, renderHook } from "@testing-library/react"
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"

import { useEdgeResize } from "./use-edge-resize"

function pointer(clientX: number, pointerId = 1, clientY = 0): ReactPointerEvent {
  return {
    button: 0,
    clientX,
    clientY,
    pointerId,
    preventDefault: jest.fn(),
    currentTarget: {
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
    },
  } as unknown as ReactPointerEvent
}

function verticalPointer(clientY: number, pointerId = 1): ReactPointerEvent {
  return pointer(0, pointerId, clientY)
}

function key(k: string): ReactKeyboardEvent {
  return { key: k, preventDefault: jest.fn() } as unknown as ReactKeyboardEvent
}

describe("useEdgeResize", () => {
  it("drags a right-edge handle: rightward grows, clamped to max", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    act(() => result.current.onPointerDown(pointer(100)))
    expect(result.current.dragging).toBe(true)
    act(() => result.current.onPointerMove(pointer(160))) // +60
    expect(onChange).toHaveBeenLastCalledWith(316)
    act(() => result.current.onPointerMove(pointer(400))) // +300 → clamp 420
    expect(onChange).toHaveBeenLastCalledWith(420)
    act(() => result.current.onPointerUp(pointer(400)))
    expect(result.current.dragging).toBe(false)
  })

  it("clamps to min when dragging left past the lower bound", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    act(() => result.current.onPointerDown(pointer(200)))
    act(() => result.current.onPointerMove(pointer(100))) // -100 → 156 → clamp 220
    expect(onChange).toHaveBeenLastCalledWith(220)
  })

  it("drags a top-edge handle: upward grows the panel below it", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ width: 32, min: 15, max: 85, onChange, edge: "top" })
    )
    act(() => result.current.onPointerDown(verticalPointer(500)))
    act(() => result.current.onPointerMove(verticalPointer(490))) // up 10 → grows
    expect(onChange).toHaveBeenLastCalledWith(42)
    act(() => result.current.onPointerMove(verticalPointer(520))) // down 20 → shrinks
    expect(onChange).toHaveBeenLastCalledWith(15) // 32 - 20 = 12 → clamp 15
  })

  it("drags a bottom-edge handle: downward grows the panel above it", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ width: 32, min: 15, max: 85, onChange, edge: "bottom" })
    )
    act(() => result.current.onPointerDown(verticalPointer(100)))
    act(() => result.current.onPointerMove(verticalPointer(120)))
    expect(onChange).toHaveBeenLastCalledWith(52)
  })

  it("converts pointer pixels into caller units via `scale`", () => {
    // A dock sized as a % of an 800px-tall viewport: 1px ≈ 0.125%.
    const onChange = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({
        width: 32,
        min: 15,
        max: 85,
        onChange,
        edge: "top",
        scale: 100 / 800,
      })
    )
    act(() => result.current.onPointerDown(verticalPointer(400)))
    act(() => result.current.onPointerMove(verticalPointer(320))) // 80px up → +10%
    expect(onChange).toHaveBeenLastCalledWith(42)
  })

  it("maps arrow keys to the handle's axis", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ width: 32, min: 15, max: 85, onChange, edge: "top", step: 2 })
    )
    act(() => result.current.onKeyDown(key("ArrowUp")))
    expect(onChange).toHaveBeenLastCalledWith(34)
    act(() => result.current.onKeyDown(key("ArrowDown")))
    expect(onChange).toHaveBeenLastCalledWith(30)
    // Horizontal keys belong to the other axis and must not resize.
    onChange.mockClear()
    act(() => result.current.onKeyDown(key("ArrowLeft")))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("bottom-edge arrow keys grow with ArrowDown", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ width: 32, min: 15, max: 85, onChange, edge: "bottom", step: 2 })
    )
    act(() => result.current.onKeyDown(key("ArrowDown")))
    expect(onChange).toHaveBeenLastCalledWith(34)
    act(() => result.current.onKeyDown(key("ArrowUp")))
    expect(onChange).toHaveBeenLastCalledWith(30)
  })

  it("ignores pointer move when no drag is active", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    act(() => result.current.onPointerMove(pointer(300)))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("inverts direction for a left-edge handle", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ width: 300, min: 220, max: 420, onChange, edge: "left" })
    )
    act(() => result.current.onPointerDown(pointer(200)))
    act(() => result.current.onPointerMove(pointer(160))) // drag left 40 → grow to 340
    expect(onChange).toHaveBeenLastCalledWith(340)
  })

  it("left-edge arrow keys grow with ArrowLeft and shrink with ArrowRight", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ width: 256, min: 220, max: 420, onChange, edge: "left", step: 16 })
    )
    act(() => result.current.onKeyDown(key("ArrowLeft")))
    expect(onChange).toHaveBeenLastCalledWith(272)
    act(() => result.current.onKeyDown(key("ArrowRight")))
    expect(onChange).toHaveBeenLastCalledWith(240)
  })

  it("onPointerUp is a no-op when no drag is in progress", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    expect(() => act(() => result.current.onPointerUp(pointer(100)))).not.toThrow()
    expect(result.current.dragging).toBe(false)
  })

  it("arrow keys nudge by the step, respecting bounds", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ width: 256, min: 220, max: 420, onChange, step: 16 })
    )
    act(() => result.current.onKeyDown(key("ArrowRight")))
    expect(onChange).toHaveBeenLastCalledWith(272)
    act(() => result.current.onKeyDown(key("ArrowLeft")))
    expect(onChange).toHaveBeenLastCalledWith(240)
  })

  it("Enter / Space and double-click reset via onReset", () => {
    const onReset = jest.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ width: 256, min: 220, max: 420, onChange: jest.fn(), onReset })
    )
    act(() => result.current.onKeyDown(key("Enter")))
    act(() => result.current.onKeyDown(key(" ")))
    act(() => result.current.onDoubleClick())
    expect(onReset).toHaveBeenCalledTimes(3)
  })

  it("swallows errors thrown by set/releasePointerCapture", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    const throwing = {
      clientX: 100,
      pointerId: 1,
      preventDefault: jest.fn(),
      currentTarget: {
        setPointerCapture: () => {
          throw new Error("nope")
        },
        releasePointerCapture: () => {
          throw new Error("nope")
        },
      },
    } as unknown as ReactPointerEvent
    expect(() => act(() => result.current.onPointerDown(throwing))).not.toThrow()
    expect(result.current.dragging).toBe(true)
    expect(() => act(() => result.current.onPointerUp(throwing))).not.toThrow()
    expect(result.current.dragging).toBe(false)
  })

  it("does not throw when the handle lacks pointer-capture APIs", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    const bare = {
      clientX: 100,
      pointerId: 1,
      preventDefault: jest.fn(),
      currentTarget: {},
    } as unknown as ReactPointerEvent
    expect(() => act(() => result.current.onPointerDown(bare))).not.toThrow()
    expect(() => act(() => result.current.onPointerUp(bare))).not.toThrow()
  })
})

describe("resize gesture lifecycle", () => {
  it("ignores secondary buttons and unrelated pointers", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    act(() => result.current.onPointerDown({ ...pointer(100), button: 2 }))
    expect(result.current.dragging).toBe(false)
    act(() => result.current.onPointerDown(pointer(100)))
    act(() => result.current.onPointerMove(pointer(200, 2)))
    act(() => result.current.onPointerUp(pointer(200, 2)))
    expect(onChange).not.toHaveBeenCalled()
    expect(result.current.dragging).toBe(true)
  })

  it.each(["onPointerCancel", "onLostPointerCapture"] as const)("cleans up on %s", (event) => {
    const { result } = renderHook(() =>
      useEdgeResize({ width: 256, min: 220, max: 420, onChange: jest.fn() })
    )
    act(() => result.current.onPointerDown(pointer(100)))
    expect(document.body).toHaveAttribute("data-edge-resizing", "horizontal")
    act(() => result.current[event](pointer(100)))
    expect(result.current.dragging).toBe(false)
    expect(document.body).not.toHaveAttribute("data-edge-resizing")
  })

  it("cancels with Escape and restores the starting size", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    act(() => result.current.onPointerDown(pointer(100)))
    act(() => result.current.onPointerMove(pointer(150)))
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })))
    expect(onChange).toHaveBeenLastCalledWith(256)
    expect(result.current.dragging).toBe(false)
  })

  it("cleans up on blur and unmount without losing existing body state", () => {
    document.body.setAttribute("data-edge-resizing", "existing")
    const { result, unmount } = renderHook(() =>
      useEdgeResize({ width: 32, min: 15, max: 85, edge: "top", onChange: jest.fn() })
    )
    act(() => result.current.onPointerDown(pointer(100)))
    expect(document.body).toHaveAttribute("data-edge-resizing", "vertical")
    act(() => window.dispatchEvent(new Event("blur")))
    expect(result.current.dragging).toBe(false)
    expect(document.body).toHaveAttribute("data-edge-resizing", "existing")
    act(() => result.current.onPointerDown(pointer(100)))
    unmount()
    expect(document.body).toHaveAttribute("data-edge-resizing", "existing")
    document.body.removeAttribute("data-edge-resizing")
  })

  it("supports boundary keys and precise Shift nudges", () => {
    const onChange = jest.fn()
    const { result } = renderHook(() => useEdgeResize({ width: 256, min: 220, max: 420, onChange }))
    act(() => result.current.onKeyDown(key("Home")))
    expect(onChange).toHaveBeenLastCalledWith(220)
    act(() => result.current.onKeyDown(key("End")))
    expect(onChange).toHaveBeenLastCalledWith(420)
    act(() => result.current.onKeyDown({ ...key("ArrowRight"), shiftKey: true }))
    expect(onChange).toHaveBeenLastCalledWith(260)
  })
})

it("handles native cancellation for consumers that only bind down/move/up", () => {
  const target = document.createElement("div")
  const { result } = renderHook(() =>
    useEdgeResize({ width: 256, min: 220, max: 420, onChange: jest.fn() })
  )
  act(() => result.current.onPointerDown({ ...pointer(100), currentTarget: target }))
  function cancel(pointerId: number) {
    const event = new Event("pointercancel")
    Object.defineProperty(event, "pointerId", { value: pointerId })
    act(() => target.dispatchEvent(event))
  }
  cancel(2)
  expect(result.current.dragging).toBe(true)
  cancel(1)
  expect(result.current.dragging).toBe(false)
  expect(document.body).not.toHaveAttribute("data-edge-resizing")
})
