/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { useIssueSelection } from "./use-issue-selection"

const ORDER = ["a", "b", "c", "d"]

describe("useIssueSelection", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useIssueSelection(ORDER))
    expect(result.current.selectedIds.size).toBe(0)
    expect(result.current.cursorId).toBeUndefined()
  })

  it("ticks and unticks a row", () => {
    const { result } = renderHook(() => useIssueSelection(ORDER))
    act(() => result.current.toggle("b"))
    expect([...result.current.selectedIds]).toEqual(["b"])
    act(() => result.current.toggle("b"))
    expect(result.current.selectedIds.size).toBe(0)
  })

  it("extends from the last plain click", () => {
    const { result } = renderHook(() => useIssueSelection(ORDER))
    act(() => result.current.toggle("b"))
    act(() => result.current.extendTo("d"))
    expect([...result.current.selectedIds].sort()).toEqual(["b", "c", "d"])
  })

  it("selects all, then clears on a second call", () => {
    const { result } = renderHook(() => useIssueSelection(ORDER))
    act(() => result.current.toggleAll())
    expect(result.current.selectedIds.size).toBe(4)
    act(() => result.current.toggleAll())
    expect(result.current.selectedIds.size).toBe(0)
  })

  it("clears", () => {
    const { result } = renderHook(() => useIssueSelection(ORDER))
    act(() => result.current.toggle("a"))
    act(() => result.current.clear())
    expect(result.current.selectedIds.size).toBe(0)
  })

  describe("rows leaving the result set", () => {
    it("never reports a selected id that is no longer on screen", () => {
      const { result, rerender } = renderHook(({ ids }) => useIssueSelection(ids), {
        initialProps: { ids: ORDER },
      })
      act(() => result.current.toggle("d"))
      rerender({ ids: ["a", "b"] })
      expect(result.current.selectedIds.has("d")).toBe(false)
    })

    it("restores it when the row comes back, because pruning is derived not destructive", () => {
      const { result, rerender } = renderHook(({ ids }) => useIssueSelection(ids), {
        initialProps: { ids: ORDER },
      })
      act(() => result.current.toggle("d"))
      rerender({ ids: ["a", "b"] })
      rerender({ ids: ORDER })
      expect(result.current.selectedIds.has("d")).toBe(true)
    })

    it("drops the cursor when its row leaves", () => {
      const { result, rerender } = renderHook(({ ids }) => useIssueSelection(ids), {
        initialProps: { ids: ORDER },
      })
      act(() => result.current.setCursorId("d"))
      rerender({ ids: ["a", "b"] })
      expect(result.current.cursorId).toBeUndefined()
    })

    it("does not extend a range across a filtered-away anchor", () => {
      const { result, rerender } = renderHook(({ ids }) => useIssueSelection(ids), {
        initialProps: { ids: ORDER },
      })
      act(() => result.current.toggle("d"))
      rerender({ ids: ["a", "b"] })
      act(() => result.current.extendTo("b"))
      expect([...result.current.selectedIds]).toEqual(["b"])
    })
  })

  describe("cursor", () => {
    it("starts at the top on the first step down", () => {
      const { result } = renderHook(() => useIssueSelection(ORDER))
      act(() => {
        result.current.moveCursor(1)
      })
      expect(result.current.cursorId).toBe("a")
    })

    it("walks the list", () => {
      const { result } = renderHook(() => useIssueSelection(ORDER))
      act(() => {
        result.current.moveCursor(1)
      })
      act(() => {
        result.current.moveCursor(1)
      })
      expect(result.current.cursorId).toBe("b")
      act(() => {
        result.current.moveCursor(-1)
      })
      expect(result.current.cursorId).toBe("a")
    })

    it("stops at the end rather than wrapping", () => {
      const { result } = renderHook(() => useIssueSelection(["a"]))
      act(() => {
        result.current.moveCursor(1)
      })
      act(() => {
        result.current.moveCursor(1)
      })
      expect(result.current.cursorId).toBe("a")
    })

    it("moves independently of what is ticked", () => {
      const { result } = renderHook(() => useIssueSelection(ORDER))
      act(() => {
        result.current.moveCursor(1)
      })
      expect(result.current.selectedIds.size).toBe(0)
    })
  })
})
