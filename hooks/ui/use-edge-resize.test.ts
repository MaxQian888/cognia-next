import { act, renderHook } from "@testing-library/react"
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"

import { useEdgeResize } from "./use-edge-resize"

function pointer(clientX: number, pointerId = 1): ReactPointerEvent {
  return {
    clientX,
    pointerId,
    preventDefault: jest.fn(),
    currentTarget: {
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
    },
  } as unknown as ReactPointerEvent
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
