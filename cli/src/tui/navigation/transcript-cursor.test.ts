import {
  INITIAL_CURSOR,
  cellAtRow,
  cellTopRow,
  clearFocus,
  closeFind,
  currentMatch,
  focusedCell,
  isFindActive,
  moveCursor,
  nextMatch,
  openFind,
  prevMatch,
  setFindQuery,
} from "./transcript-cursor"
import type { Cell } from "../state/types"

const cells: Cell[] = [
  { id: "a", kind: "user", text: "hello world" },
  { id: "b", kind: "assistant", raw: "the world is round\nand wide" },
  { id: "c", kind: "user", text: "goodbye" },
]

describe("transcript-cursor", () => {
  describe("find lifecycle", () => {
    it("opens with an empty query and no matches", () => {
      const s = openFind(INITIAL_CURSOR)
      expect(isFindActive(s)).toBe(true)
      expect(s.find).toEqual({ query: "", matches: [], index: 0 })
      expect(currentMatch(s)).toBeNull()
    })

    it("openFind is a no-op when already open", () => {
      const once = openFind(INITIAL_CURSOR)
      expect(openFind(once)).toBe(once)
    })

    it("setFindQuery computes matches and focuses the first hit", () => {
      const s = setFindQuery(openFind(INITIAL_CURSOR), cells, "world")
      expect(s.find?.matches.map((m) => m.cellId)).toEqual(["a", "b"])
      expect(s.find?.index).toBe(0)
      expect(s.focusedCellId).toBe("a")
      expect(currentMatch(s)?.cellId).toBe("a")
    })

    it("keeps the prior focus when a query has no matches", () => {
      const focused = { focusedCellId: "c", find: { query: "", matches: [], index: 0 } }
      const s = setFindQuery(focused, cells, "zzz")
      expect(s.find?.matches).toEqual([])
      expect(s.focusedCellId).toBe("c")
      expect(currentMatch(s)).toBeNull()
    })

    it("setFindQuery is a no-op when find is closed", () => {
      expect(setFindQuery(INITIAL_CURSOR, cells, "world")).toBe(INITIAL_CURSOR)
    })

    it("closeFind keeps the cursor on the last match", () => {
      const s = closeFind(setFindQuery(openFind(INITIAL_CURSOR), cells, "world"))
      expect(s.find).toBeNull()
      expect(s.focusedCellId).toBe("a")
    })

    it("closeFind is a no-op when already closed", () => {
      expect(closeFind(INITIAL_CURSOR)).toBe(INITIAL_CURSOR)
    })
  })

  describe("match navigation", () => {
    const opened = setFindQuery(openFind(INITIAL_CURSOR), cells, "world")

    it("next advances and wraps", () => {
      const one = nextMatch(opened)
      expect(one.find?.index).toBe(1)
      expect(one.focusedCellId).toBe("b")
      const wrap = nextMatch(one)
      expect(wrap.find?.index).toBe(0)
      expect(wrap.focusedCellId).toBe("a")
    })

    it("prev wraps backwards", () => {
      const back = prevMatch(opened)
      expect(back.find?.index).toBe(1)
      expect(back.focusedCellId).toBe("b")
    })

    it("stepping with no hits is a no-op", () => {
      const empty = setFindQuery(openFind(INITIAL_CURSOR), cells, "zzz")
      expect(nextMatch(empty)).toBe(empty)
      expect(prevMatch(empty)).toBe(empty)
    })

    it("stepping with find closed is a no-op", () => {
      expect(nextMatch(INITIAL_CURSOR)).toBe(INITIAL_CURSOR)
    })
  })

  describe("moveCursor", () => {
    it("enters from the bottom on up, top on down", () => {
      expect(moveCursor(INITIAL_CURSOR, cells, "up").focusedCellId).toBe("c")
      expect(moveCursor(INITIAL_CURSOR, cells, "down").focusedCellId).toBe("a")
    })

    it("steps to the adjacent cell and clamps at the ends", () => {
      const onB = { focusedCellId: "b", find: null }
      expect(moveCursor(onB, cells, "up").focusedCellId).toBe("a")
      expect(moveCursor(onB, cells, "down").focusedCellId).toBe("c")
      const onA = { focusedCellId: "a", find: null }
      expect(moveCursor(onA, cells, "up").focusedCellId).toBe("a")
      const onC = { focusedCellId: "c", find: null }
      expect(moveCursor(onC, cells, "down").focusedCellId).toBe("c")
    })

    it("is a no-op with no cells", () => {
      expect(moveCursor(INITIAL_CURSOR, [], "up")).toBe(INITIAL_CURSOR)
    })
  })

  describe("focus helpers", () => {
    it("focusedCell resolves the cell or null", () => {
      expect(focusedCell(cells, { focusedCellId: "b", find: null })?.kind).toBe("assistant")
      expect(focusedCell(cells, INITIAL_CURSOR)).toBeNull()
      expect(focusedCell(cells, { focusedCellId: "missing", find: null })).toBeNull()
    })

    it("clearFocus resets to the initial state", () => {
      expect(clearFocus({ focusedCellId: "b", find: null })).toEqual(INITIAL_CURSOR)
      expect(clearFocus(INITIAL_CURSOR)).toBe(INITIAL_CURSOR)
    })
  })

  describe("cellTopRow", () => {
    const heights = new Map([
      ["a", 2],
      ["b", 3],
      ["c", 1],
    ])
    it("sums preceding cell heights plus the inter-cell gap", () => {
      expect(cellTopRow(["a", "b", "c"], heights, "a")).toBe(0)
      expect(cellTopRow(["a", "b", "c"], heights, "b")).toBe(3) // 2 + gap 1
      expect(cellTopRow(["a", "b", "c"], heights, "c")).toBe(7) // 2+1 + 3+1
    })
    it("treats unmeasured cells as zero height", () => {
      expect(cellTopRow(["a", "b", "c"], new Map([["a", 2]]), "c")).toBe(4) // 2+1 + 0+1
    })
    it("returns null when the target isn't in the list", () => {
      expect(cellTopRow(["a", "b"], heights, "z")).toBeNull()
    })
    it("honours a custom gap", () => {
      expect(cellTopRow(["a", "b"], heights, "b", 0)).toBe(2)
    })
  })

  describe("cellAtRow", () => {
    const ids = ["a", "b", "c"]
    // a: rows 0-1 (h2), gap 2; b: rows 3-5 (h3), gap 6; c: row 7 (h1).
    const heights = new Map([
      ["a", 2],
      ["b", 3],
      ["c", 1],
    ])
    it("maps a row inside a cell's band to that cell", () => {
      expect(cellAtRow(ids, heights, 0)).toBe("a")
      expect(cellAtRow(ids, heights, 1)).toBe("a")
      expect(cellAtRow(ids, heights, 3)).toBe("b")
      expect(cellAtRow(ids, heights, 5)).toBe("b")
      expect(cellAtRow(ids, heights, 7)).toBe("c")
    })
    it("returns null on the inter-cell gap row", () => {
      expect(cellAtRow(ids, heights, 2)).toBeNull() // gap after a
      expect(cellAtRow(ids, heights, 6)).toBeNull() // gap after b
    })
    it("returns null below the last cell and for negative rows", () => {
      expect(cellAtRow(ids, heights, 8)).toBeNull()
      expect(cellAtRow(ids, heights, -1)).toBeNull()
    })
    it("skips unmeasured (zero-height) cells", () => {
      // b unmeasured → its band collapses; row 3 falls on b's gap → null.
      const partial = new Map([
        ["a", 2],
        ["c", 1],
      ])
      expect(cellAtRow(ids, partial, 0)).toBe("a")
      expect(cellAtRow(ids, partial, 3)).toBeNull()
      // a(0-1) gap(2) b(0,gap 3) c at row 4.
      expect(cellAtRow(ids, partial, 4)).toBe("c")
    })
    it("round-trips with cellTopRow for measured cells", () => {
      for (const id of ids) {
        const top = cellTopRow(ids, heights, id)!
        expect(cellAtRow(ids, heights, top)).toBe(id)
      }
    })
  })
})
