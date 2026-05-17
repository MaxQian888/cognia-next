/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  useDragSnapshot,
  type DragSnapshotSourceNode,
} from "./use-drag-snapshot"

function n(
  id: string,
  x: number,
  y: number,
  extra: Partial<DragSnapshotSourceNode> = {}
): DragSnapshotSourceNode {
  return { id, position: { x, y }, ...extra }
}

describe("useDragSnapshot", () => {
  it("starts with a null snapshot", () => {
    const { result } = renderHook(() => useDragSnapshot())
    expect(result.current.snapshot.current).toBeNull()
  })

  it("capture builds a Map keyed by node id, with explicit width/height honoured", () => {
    const { result } = renderHook(() => useDragSnapshot())
    act(() => result.current.capture([n("a", 0, 0, { width: 300, height: 100 }), n("b", 10, 20)]))
    const map = result.current.snapshot.current
    expect(map).not.toBeNull()
    expect(map!.size).toBe(2)
    expect(map!.get("a")).toEqual({ id: "a", x: 0, y: 0, width: 300, height: 100 })
    expect(map!.get("b")).toEqual({
      id: "b",
      x: 10,
      y: 20,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    })
  })

  it("capture prefers measured size over the explicit prop", () => {
    const { result } = renderHook(() => useDragSnapshot())
    act(() =>
      result.current.capture([
        n("a", 0, 0, { width: 100, height: 50, measured: { width: 350, height: 120 } }),
      ])
    )
    expect(result.current.snapshot.current!.get("a")).toEqual({
      id: "a",
      x: 0,
      y: 0,
      width: 350,
      height: 120,
    })
  })

  it("capture excludes the dragged node when excludeId is provided", () => {
    const { result } = renderHook(() => useDragSnapshot())
    act(() => result.current.capture([n("a", 0, 0), n("b", 0, 0), n("c", 0, 0)], "b"))
    const map = result.current.snapshot.current!
    expect(map.has("a")).toBe(true)
    expect(map.has("b")).toBe(false)
    expect(map.has("c")).toBe(true)
  })

  it("release clears the snapshot ref", () => {
    const { result } = renderHook(() => useDragSnapshot())
    act(() => result.current.capture([n("a", 0, 0)]))
    expect(result.current.snapshot.current).not.toBeNull()
    act(() => result.current.release())
    expect(result.current.snapshot.current).toBeNull()
  })

  it("returns stable capture / release identities across renders", () => {
    const { result, rerender } = renderHook(() => useDragSnapshot())
    const first = result.current
    rerender()
    expect(result.current.capture).toBe(first.capture)
    expect(result.current.release).toBe(first.release)
    expect(result.current.snapshot).toBe(first.snapshot)
  })

  it("capture replaces the previous snapshot (drag again clears stale peers)", () => {
    const { result } = renderHook(() => useDragSnapshot())
    act(() => result.current.capture([n("a", 0, 0), n("b", 0, 0)]))
    act(() => result.current.capture([n("c", 0, 0)]))
    const map = result.current.snapshot.current!
    expect(map.size).toBe(1)
    expect(map.has("c")).toBe(true)
  })
})
