import {
  clearSelection,
  EMPTY_ISSUE_SELECTION,
  pruneSelection,
  selectRange,
  stepCursor,
  toggleSelectAll,
  toggleSelection,
  type IssueSelectionState,
} from "./selection"

const ORDER = ["a", "b", "c", "d", "e"]
const state = (ids: string[], anchor: string | null = null): IssueSelectionState => ({
  selected: new Set(ids),
  anchor,
})

describe("toggleSelection", () => {
  it("adds an unselected row and anchors on it", () => {
    const next = toggleSelection(EMPTY_ISSUE_SELECTION, "b")
    expect([...next.selected]).toEqual(["b"])
    expect(next.anchor).toBe("b")
  })

  it("removes a selected row", () => {
    expect([...toggleSelection(state(["a", "b"]), "a").selected]).toEqual(["b"])
  })

  it("moves the anchor even when deselecting, so the next shift-range starts here", () => {
    expect(toggleSelection(state(["a"], "a"), "a").anchor).toBe("a")
  })

  it("does not mutate its input", () => {
    const input = state(["a"])
    toggleSelection(input, "b")
    expect([...input.selected]).toEqual(["a"])
  })
})

describe("selectRange", () => {
  it("selects everything between the anchor and the target, inclusive", () => {
    const next = selectRange(state(["b"], "b"), ORDER, "d")
    expect([...next.selected].sort()).toEqual(["b", "c", "d"])
  })

  it("works backwards", () => {
    const next = selectRange(state(["d"], "d"), ORDER, "b")
    expect([...next.selected].sort()).toEqual(["b", "c", "d"])
  })

  it("adds to what was already selected rather than replacing it", () => {
    const next = selectRange(state(["a", "c"], "c"), ORDER, "d")
    expect([...next.selected].sort()).toEqual(["a", "c", "d"])
  })

  it("keeps the anchor put, so holding shift keeps extending from one origin", () => {
    expect(selectRange(state(["b"], "b"), ORDER, "d").anchor).toBe("b")
  })

  it("degrades to a single selection when there is no anchor", () => {
    const next = selectRange(EMPTY_ISSUE_SELECTION, ORDER, "c")
    expect([...next.selected]).toEqual(["c"])
    expect(next.anchor).toBe("c")
  })

  it("degrades the same way when the anchor has been filtered away", () => {
    const next = selectRange(state([], "zzz"), ORDER, "c")
    expect([...next.selected]).toEqual(["c"])
  })

  it("ignores a target that is not on screen", () => {
    const input = state(["a"], "a")
    expect(selectRange(input, ORDER, "zzz")).toBe(input)
  })
})

describe("toggleSelectAll", () => {
  it("selects every visible row", () => {
    expect([...toggleSelectAll(EMPTY_ISSUE_SELECTION, ORDER).selected].sort()).toEqual(ORDER)
  })

  it("clears when everything is already selected", () => {
    expect([...toggleSelectAll(state(ORDER), ORDER).selected]).toEqual([])
  })

  it("selects all when only some were selected", () => {
    expect(toggleSelectAll(state(["a"]), ORDER).selected.size).toBe(ORDER.length)
  })

  it("is a clear, not a select-all, for an empty list", () => {
    expect([...toggleSelectAll(state(["a"]), []).selected]).toEqual([])
  })
})

describe("clearSelection", () => {
  it("empties the selection and forgets the anchor", () => {
    const next = clearSelection()
    expect(next.selected.size).toBe(0)
    expect(next.anchor).toBeNull()
  })
})

describe("pruneSelection", () => {
  it("returns the SAME object when nothing was dropped", () => {
    const input = state(["a", "b"], "a")
    expect(pruneSelection(input, ORDER)).toBe(input)
  })

  it("drops ids that are no longer on screen", () => {
    expect([...pruneSelection(state(["a", "zzz"]), ORDER).selected]).toEqual(["a"])
  })

  it("forgets an anchor that scrolled out of the result set", () => {
    expect(pruneSelection(state(["a"], "zzz"), ORDER).anchor).toBeNull()
  })

  it("keeps an anchor that is still present", () => {
    expect(pruneSelection(state(["a"], "a"), ORDER).anchor).toBe("a")
  })

  it("empties everything when the result set is empty", () => {
    expect(pruneSelection(state(["a", "b"], "a"), []).selected.size).toBe(0)
  })
})

describe("stepCursor", () => {
  it("starts at the top going down and the bottom going up", () => {
    expect(stepCursor(ORDER, undefined, 1)).toBe("a")
    expect(stepCursor(ORDER, undefined, -1)).toBe("e")
  })

  it("moves one row at a time", () => {
    expect(stepCursor(ORDER, "b", 1)).toBe("c")
    expect(stepCursor(ORDER, "b", -1)).toBe("a")
  })

  it("stops at the ends rather than wrapping and losing the user's place", () => {
    expect(stepCursor(ORDER, "e", 1)).toBe("e")
    expect(stepCursor(ORDER, "a", -1)).toBe("a")
  })

  it("recovers to the top when the cursor row vanished", () => {
    expect(stepCursor(ORDER, "zzz", 1)).toBe("a")
  })

  it("has nowhere to go in an empty list", () => {
    expect(stepCursor([], "a", 1)).toBeUndefined()
  })
})
