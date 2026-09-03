/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import { act } from "react"

import { useEdgeSwipe } from "./use-edge-swipe"

type Point = { x: number; y: number }

function touchList(points: Point[]): TouchList {
  const items = points.map((p) => ({ clientX: p.x, clientY: p.y }) as Touch)
  return Object.assign(items, {
    item: (index: number) => items[index] ?? null,
  }) as unknown as TouchList
}

function fire(type: string, touches: Point[], changed: Point[] = touches) {
  const event = new Event(type, { bubbles: true }) as TouchEvent
  Object.defineProperty(event, "touches", { value: touchList(touches) })
  Object.defineProperty(event, "changedTouches", { value: touchList(changed) })
  act(() => {
    window.dispatchEvent(event)
  })
}

function swipe(from: Point, to: Point) {
  fire("touchstart", [from])
  fire("touchmove", [to])
  fire("touchend", [to])
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 400, configurable: true })
})

describe("useEdgeSwipe", () => {
  it("opens on an inward drag that starts in the left edge zone", () => {
    const onOpen = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onOpen }))
    swipe({ x: 6, y: 300 }, { x: 140, y: 306 })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("ignores an inward drag that started away from the edge", () => {
    const onOpen = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onOpen }))
    swipe({ x: 180, y: 300 }, { x: 320, y: 300 })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("closes on an outward drag from anywhere", () => {
    const onClose = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onClose }))
    swipe({ x: 240, y: 200 }, { x: 100, y: 210 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("reads the right edge as the mirror image", () => {
    const onOpen = jest.fn()
    const onClose = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "right", onOpen, onClose }))
    swipe({ x: 396, y: 100 }, { x: 250, y: 100 })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("rejects a mostly-vertical drag so a list scroll never opens the rail", () => {
    const onOpen = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onOpen }))
    fire("touchstart", [{ x: 6, y: 300 }])
    fire("touchmove", [{ x: 30, y: 200 }])
    fire("touchend", [{ x: 140, y: 200 }])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("rejects a second finger landing mid-gesture", () => {
    const onOpen = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onOpen }))
    fire("touchstart", [{ x: 6, y: 300 }])
    fire("touchmove", [
      { x: 60, y: 300 },
      { x: 200, y: 300 },
    ])
    fire("touchend", [{ x: 200, y: 300 }])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("stops short of the threshold", () => {
    const onOpen = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onOpen, threshold: 120 }))
    swipe({ x: 6, y: 300 }, { x: 100, y: 300 })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("detaches every listener when disabled", () => {
    const onOpen = jest.fn()
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useEdgeSwipe({ edge: "left", enabled, onOpen }),
      { initialProps: { enabled: true } }
    )
    rerender({ enabled: false })
    swipe({ x: 6, y: 300 }, { x: 140, y: 300 })
    expect(onOpen).not.toHaveBeenCalled()
  })
})
