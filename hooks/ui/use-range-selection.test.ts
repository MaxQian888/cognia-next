/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { useRangeSelection } from "./use-range-selection"

const PLAIN = { ctrlKey: false, metaKey: false, shiftKey: false }
const CTRL = { ctrlKey: true, metaKey: false, shiftKey: false }
const CMD = { ctrlKey: false, metaKey: true, shiftKey: false }
const SHIFT = { ctrlKey: false, metaKey: false, shiftKey: true }
const CTRL_SHIFT = { ctrlKey: true, metaKey: false, shiftKey: true }

function ids(set: ReadonlySet<string>) {
  return [...set].sort()
}

describe("useRangeSelection", () => {
  it("plain click selects only that id and parks the anchor on it", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c"]))
    act(() => result.current.handleClick("b", PLAIN))
    expect(ids(result.current.selected)).toEqual(["b"])
    expect(result.current.anchorId).toBe("b")
    expect(result.current.lastInteractionWasModified).toBe(false)
    expect(result.current.isSelected("b")).toBe(true)
    expect(result.current.isSelected("a")).toBe(false)
  })

  it("Ctrl-click toggles ids individually and tracks the anchor", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c"]))
    act(() => result.current.handleClick("a", CTRL))
    act(() => result.current.handleClick("c", CTRL))
    expect(ids(result.current.selected)).toEqual(["a", "c"])
    expect(result.current.anchorId).toBe("c")
    expect(result.current.lastInteractionWasModified).toBe(true)
    act(() => result.current.handleClick("a", CTRL))
    expect(ids(result.current.selected)).toEqual(["c"])
    expect(result.current.anchorId).toBe("a")
  })

  it("Cmd-click is equivalent to Ctrl-click (macOS parity)", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c"]))
    act(() => result.current.handleClick("a", CMD))
    act(() => result.current.handleClick("c", CMD))
    expect(ids(result.current.selected)).toEqual(["a", "c"])
  })

  it("Shift-click selects the inclusive range from the anchor to the clicked id", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c", "d", "e"]))
    act(() => result.current.handleClick("b", PLAIN))
    act(() => result.current.handleClick("d", SHIFT))
    expect(ids(result.current.selected)).toEqual(["b", "c", "d"])
    expect(result.current.anchorId).toBe("b")
  })

  it("Shift-click after no anchor falls back to selecting just the clicked id", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c"]))
    act(() => result.current.handleClick("b", SHIFT))
    expect(ids(result.current.selected)).toEqual(["b"])
    expect(result.current.anchorId).toBe("b")
  })

  it("Shift-click extends in reverse order from the anchor", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c", "d"]))
    act(() => result.current.handleClick("c", PLAIN))
    act(() => result.current.handleClick("a", SHIFT))
    expect(ids(result.current.selected)).toEqual(["a", "b", "c"])
    expect(result.current.anchorId).toBe("c")
  })

  it("Ctrl+Shift-click unions the new range with the existing selection", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c", "d", "e"]))
    act(() => result.current.handleClick("a", CTRL))
    act(() => result.current.handleClick("b", CTRL))
    act(() => result.current.handleClick("e", CTRL_SHIFT))
    expect(ids(result.current.selected)).toEqual(["a", "b", "c", "d", "e"])
  })

  it("selectAll picks every visible id", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c"]))
    act(() => result.current.selectAll())
    expect(ids(result.current.selected)).toEqual(["a", "b", "c"])
    expect(result.current.lastInteractionWasModified).toBe(true)
  })

  it("clear empties the selection and resets the anchor", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b", "c"]))
    act(() => result.current.handleClick("a", CTRL))
    act(() => result.current.handleClick("b", CTRL))
    act(() => result.current.clear())
    expect(ids(result.current.selected)).toEqual([])
    expect(result.current.anchorId).toBeNull()
    expect(result.current.lastInteractionWasModified).toBe(false)
  })

  it("drops ids that are no longer present when orderedIds shrinks", () => {
    const { result, rerender } = renderHook(({ orderedIds }) => useRangeSelection(orderedIds), {
      initialProps: { orderedIds: ["a", "b", "c"] as readonly string[] },
    })
    act(() => result.current.handleClick("a", CTRL))
    act(() => result.current.handleClick("c", CTRL))
    expect(ids(result.current.selected)).toEqual(["a", "c"])
    rerender({ orderedIds: ["a", "b"] })
    expect(ids(result.current.selected)).toEqual(["a"])
    expect(result.current.anchorId).toBe(null) // c was the anchor and is gone
  })

  it("isSelected returns false for ids never selected", () => {
    const { result } = renderHook(() => useRangeSelection(["a", "b"]))
    expect(result.current.isSelected("a")).toBe(false)
    act(() => result.current.handleClick("a", PLAIN))
    expect(result.current.isSelected("a")).toBe(true)
    expect(result.current.isSelected("b")).toBe(false)
  })

  // Perf invariant: every click would invalidate handleClick if its identity
  // depended on `rawAnchor`, which would force every memoized SessionRow to
  // re-render. We guard against that regression by asserting the reference
  // stays stable across successive clicks while orderedIds is unchanged.
  // The orderedIds array is hoisted outside the hook factory so the
  // hook's `useCallback` doesn't see a fresh dep on every render — this
  // matches how real consumers feed a `useMemo`-stable list in.
  it("handleClick keeps a stable identity across clicks (so SessionRow memo holds)", () => {
    const STABLE: readonly string[] = ["a", "b", "c"]
    const { result } = renderHook(() => useRangeSelection(STABLE))
    const before = result.current.handleClick
    act(() => result.current.handleClick("a", CTRL))
    act(() => result.current.handleClick("b", CTRL))
    act(() => result.current.handleClick("c", SHIFT))
    expect(result.current.handleClick).toBe(before)
  })
})
