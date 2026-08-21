import type { IssueStatus } from "@/types/issues"
import { currentBoardColumn, nextBoardColumnCoordinates, type BoardRect } from "./board-keyboard"

const column = (left: number): BoardRect => ({ left, top: 12, width: 264, height: 600 })

/** The six columns as the board actually lays them out: 264px + 12px gaps. */
const ALL = new Map<IssueStatus, BoardRect>([
  ["backlog", column(12)],
  ["todo", column(288)],
  ["in_progress", column(564)],
  ["in_review", column(840)],
  ["done", column(1116)],
  ["canceled", column(1392)],
])

const card = (left: number, top = 60): BoardRect => ({ left, top, width: 246, height: 120 })

describe("currentBoardColumn", () => {
  it("finds the column containing the card's centre", () => {
    expect(currentBoardColumn(card(300), ALL)).toBe("todo")
    expect(currentBoardColumn(card(850), ALL)).toBe("in_review")
  })

  it("falls back to the nearest column for a card held in the gap between two", () => {
    // The gap runs 276→288; a centre at 284 is inside neither column, and is
    // 136px from todo's centre against 140px from backlog's.
    const inGap: BoardRect = { left: 282, top: 60, width: 4, height: 120 }
    expect(currentBoardColumn(inGap, ALL)).toBe("todo")
  })

  it("returns null when there are no columns at all", () => {
    expect(currentBoardColumn(card(300), new Map())).toBeNull()
  })
})

describe("nextBoardColumnCoordinates", () => {
  it("steps to the column next door, not to whichever corner is nearest", () => {
    const next = nextBoardColumnCoordinates("right", card(300), ALL)
    expect(next?.x).toBe(ALL.get("in_progress")!.left + 8)
  })

  it("steps left", () => {
    const next = nextBoardColumnCoordinates("left", card(850), ALL)
    expect(next?.x).toBe(ALL.get("in_progress")!.left + 8)
  })

  it("stops at the right edge rather than wrapping to the start", () => {
    expect(nextBoardColumnCoordinates("right", card(1400), ALL)).toBeNull()
  })

  it("stops at the left edge", () => {
    expect(nextBoardColumnCoordinates("left", card(20), ALL)).toBeNull()
  })

  it("skips a column that is not rendered", () => {
    const sparse = new Map(ALL)
    sparse.delete("in_progress")
    const next = nextBoardColumnCoordinates("right", card(300), sparse)
    expect(next?.x).toBe(ALL.get("in_review")!.left + 8)
  })

  it("carries the vertical position across, so crossing the board is not also a jump", () => {
    const next = nextBoardColumnCoordinates("right", card(300, 220), ALL)
    expect(next?.y).toBe(220)
  })

  it("never lands on top of the target column's header", () => {
    const next = nextBoardColumnCoordinates("right", card(300, 0), ALL)
    expect(next?.y).toBe(12 + 44)
  })

  it("clamps a card held below a short column back inside it", () => {
    const short = new Map<IssueStatus, BoardRect>([
      ["todo", column(288)],
      ["in_progress", { left: 564, top: 12, width: 264, height: 200 }],
    ])
    const next = nextBoardColumnCoordinates("right", card(300, 500), short)
    // top 12 + height 200 - card height 120 = 92
    expect(next?.y).toBe(92)
  })

  it("returns null when the card is over nothing", () => {
    expect(nextBoardColumnCoordinates("right", card(300), new Map())).toBeNull()
  })
})
