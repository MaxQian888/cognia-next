/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useTranscriptCursor } from "./useTranscriptCursor"
import type { Cell } from "../state/types"

const cells: Cell[] = [
  { id: "a", kind: "user", text: "hello world" },
  { id: "b", kind: "assistant", raw: "the world is round" },
  { id: "c", kind: "user", text: "goodbye" },
]

describe("useTranscriptCursor", () => {
  it("is idle and not measuring at first", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells))
    expect(result.current.state.find).toBeNull()
    expect(result.current.measuring).toBe(false)
    expect(result.current.targetRow).toBeNull()
    expect(result.current.focused).toBeNull()
  })

  it("opening find turns on measuring and exposes the FindBar counts", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells))
    act(() => result.current.open())
    expect(result.current.measuring).toBe(true)
    act(() => result.current.setQuery("world"))
    expect(result.current.matchCount).toBe(2)
    expect(result.current.matchIndex).toBe(0)
    expect(result.current.focused?.id).toBe("a")
    expect(result.current.match?.cellId).toBe("a")
  })

  it("computes the target row from reported cell heights", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells))
    act(() => {
      result.current.reportCellHeight("a", 2)
      result.current.reportCellHeight("b", 3)
    })
    act(() => result.current.open())
    act(() => result.current.setQuery("round")) // matches cell "b"
    // top of "b" = height(a) 2 + gap 1 = 3
    expect(result.current.targetRow).toBe(3)
  })

  it("navigates matches and updates focus", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells))
    act(() => result.current.open())
    act(() => result.current.setQuery("world"))
    act(() => result.current.next())
    expect(result.current.matchIndex).toBe(1)
    expect(result.current.focused?.id).toBe("b")
    act(() => result.current.prev())
    expect(result.current.focused?.id).toBe("a")
  })

  it("move enters cursor mode without find and keeps measuring", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells))
    act(() => result.current.move("up"))
    expect(result.current.state.find).toBeNull()
    expect(result.current.focused?.id).toBe("c")
    expect(result.current.measuring).toBe(true)
  })

  it("clear resets focus, find, and measurement", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells))
    act(() => result.current.open())
    act(() => result.current.setQuery("world"))
    act(() => result.current.clear())
    expect(result.current.state.find).toBeNull()
    expect(result.current.focused).toBeNull()
    expect(result.current.measuring).toBe(false)
    expect(result.current.targetRow).toBeNull()
  })

  it("alwaysMeasure keeps measuring on even when idle (for click-to-expand)", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells, true))
    expect(result.current.state.find).toBeNull()
    expect(result.current.focused).toBeNull()
    expect(result.current.measuring).toBe(true)
  })

  it("maps a content row to the cell under it once heights are reported", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells, true))
    act(() => {
      result.current.reportCellHeight("a", 2) // rows 0-1
      result.current.reportCellHeight("b", 3) // rows 3-5 (after gap)
      result.current.reportCellHeight("c", 1) // row 7
    })
    expect(result.current.cellIdAtContentRow(0)).toBe("a")
    expect(result.current.cellIdAtContentRow(4)).toBe("b")
    expect(result.current.cellIdAtContentRow(7)).toBe("c")
    expect(result.current.cellIdAtContentRow(2)).toBeNull() // gap row
  })

  it("returns null from cellIdAtContentRow before any height is measured", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells, true))
    expect(result.current.cellIdAtContentRow(0)).toBeNull()
  })

  it("ignores a repeated height report (stable identity)", () => {
    const { result } = renderHook(() => useTranscriptCursor(cells))
    const report = result.current.reportCellHeight
    act(() => result.current.reportCellHeight("a", 2))
    act(() => result.current.reportCellHeight("a", 2))
    expect(result.current.reportCellHeight).toBe(report)
  })
})
