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

function fire(
  type: string,
  touches: Point[],
  changed: Point[] = touches,
  target: EventTarget = window
) {
  const event = new Event(type, { bubbles: true }) as TouchEvent
  Object.defineProperty(event, "touches", { value: touchList(touches) })
  Object.defineProperty(event, "changedTouches", { value: touchList(changed) })
  act(() => {
    target.dispatchEvent(event)
  })
}

function swipe(from: Point, to: Point, target: EventTarget = window) {
  fire("touchstart", [from], [from], target)
  fire("touchmove", [to], [to], target)
  fire("touchend", [], [to], target)
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 400, configurable: true })
})

afterEach(() => {
  document.body.innerHTML = ""
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

  it("leaves a drag that starts on a swipeable row to the row", () => {
    // The row's own reveal commits at ~108px; the drawer's close threshold is
    // 56px. Reading this drag as a close shut the drawer mid-swipe.
    const onClose = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onClose }))
    const row = document.createElement("div")
    row.setAttribute("data-swipe-row", "")
    const label = document.createElement("span")
    row.appendChild(label)
    document.body.appendChild(row)
    swipe({ x: 240, y: 200 }, { x: 100, y: 204 }, label)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("honors the explicit opt-out for other sideways-panning surfaces", () => {
    const onOpen = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onOpen }))
    const carousel = document.createElement("div")
    carousel.setAttribute("data-edge-swipe-ignore", "")
    document.body.appendChild(carousel)
    swipe({ x: 6, y: 300 }, { x: 140, y: 300 }, carousel)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("still closes from a drag that starts beside the row", () => {
    const onClose = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onClose }))
    const row = document.createElement("div")
    row.setAttribute("data-swipe-row", "")
    document.body.appendChild(row)
    const header = document.createElement("header")
    document.body.appendChild(header)
    swipe({ x: 240, y: 200 }, { x: 100, y: 204 }, header)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("lets the caller veto where a gesture may start", () => {
    const onClose = jest.fn()
    const outside = document.createElement("div")
    const inside = document.createElement("div")
    inside.setAttribute("data-drawer", "")
    document.body.append(outside, inside)
    renderHook(() =>
      useEdgeSwipe({
        edge: "left",
        onClose,
        ignore: (target) => target.closest("[data-drawer]") === null,
      })
    )
    swipe({ x: 240, y: 200 }, { x: 100, y: 204 }, outside)
    expect(onClose).not.toHaveBeenCalled()
    swipe({ x: 240, y: 200 }, { x: 100, y: 204 }, inside)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("reads the latest veto without re-attaching", () => {
    const onClose = jest.fn()
    const el = document.createElement("div")
    document.body.appendChild(el)
    const { rerender } = renderHook(
      ({ blocked }: { blocked: boolean }) =>
        useEdgeSwipe({ edge: "left", onClose, ignore: () => blocked }),
      { initialProps: { blocked: true } }
    )
    swipe({ x: 240, y: 200 }, { x: 100, y: 204 }, el)
    expect(onClose).not.toHaveBeenCalled()
    rerender({ blocked: false })
    swipe({ x: 240, y: 200 }, { x: 100, y: 204 }, el)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not carry an ignored touch into the next gesture", () => {
    // The ignored start must clear any tracking, or a later touchend without
    // its own start would be read against stale coordinates.
    const onClose = jest.fn()
    renderHook(() => useEdgeSwipe({ edge: "left", onClose }))
    const row = document.createElement("div")
    row.setAttribute("data-swipe-row", "")
    document.body.appendChild(row)
    fire("touchstart", [{ x: 240, y: 200 }], [{ x: 240, y: 200 }], window)
    fire("touchstart", [{ x: 240, y: 200 }], [{ x: 240, y: 200 }], row)
    fire("touchend", [], [{ x: 100, y: 200 }], window)
    expect(onClose).not.toHaveBeenCalled()
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
