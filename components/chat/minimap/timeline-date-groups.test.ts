import { dateHeaderAtOrBefore, formatDateHeader, turnDateHeaders } from "./timeline-date-groups"
import type { TimelineTurn } from "./use-timeline-turns"

// 2024-06-20 15:00 local.
const NOW = new Date(2024, 5, 20, 15, 0, 0).getTime()
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime()

const LABELS = { now: NOW, todayLabel: "Today", yesterdayLabel: "Yesterday", locale: "en-US" }

function turn(index: number, time?: number): TimelineTurn {
  return {
    id: `u${index}`,
    index,
    messageIds: [`u${index}`],
    label: `Turn ${index}`,
    preview: `Turn ${index}`,
    time,
    replyCount: 0,
  }
}

describe("formatDateHeader", () => {
  it("names today and yesterday rather than dating them", () => {
    // The rows below already read "14:32" and "Yesterday 14:32"; a bare date
    // above them would be a second, competing vocabulary for the same day.
    expect(formatDateHeader(at(2024, 5, 20, 9), LABELS)).toBe("Today")
    expect(formatDateHeader(at(2024, 5, 19, 9), LABELS)).toBe("Yesterday")
  })

  it("uses a weekday for the past week", () => {
    // 2024-06-17 was a Monday.
    expect(formatDateHeader(at(2024, 5, 17), LABELS)).toContain("Mon")
  })

  it("drops the weekday once it stops disambiguating", () => {
    // Beyond a week "Tue" no longer tells you which Tuesday.
    const header = formatDateHeader(at(2024, 4, 2), LABELS)!
    expect(header).toContain("May")
    expect(header).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/)
  })

  it("adds the year only when it differs from now", () => {
    expect(formatDateHeader(at(2023, 10, 2), LABELS)).toContain("2023")
    expect(formatDateHeader(at(2024, 0, 2), LABELS)).not.toContain("2024")
  })

  it("returns null for an unusable timestamp", () => {
    expect(formatDateHeader(Number.NaN, LABELS)).toBeNull()
    expect(formatDateHeader(Number.POSITIVE_INFINITY, LABELS)).toBeNull()
  })
})

describe("turnDateHeaders", () => {
  it("marks only the turn that opens each day", () => {
    const headers = turnDateHeaders(
      [
        turn(0, at(2024, 5, 18, 9)),
        turn(1, at(2024, 5, 18, 17)),
        turn(2, at(2024, 5, 20, 9)),
        turn(3, at(2024, 5, 20, 11)),
      ],
      LABELS
    )
    expect([...headers.keys()]).toEqual([0, 2])
    expect(headers.get(2)).toBe("Today")
  })

  it("returns nothing for an empty conversation", () => {
    expect(turnDateHeaders([], LABELS).size).toBe(0)
  })

  it("skips turns with no timestamp rather than grouping them as unknown", () => {
    // The just-typed turn is not persisted yet. It always sits at the end of the
    // day already on screen, so a header there would be noise.
    const headers = turnDateHeaders([turn(0, at(2024, 5, 20, 9)), turn(1, undefined)], LABELS)
    expect([...headers.keys()]).toEqual([0])
  })

  it("does not let an untimed turn split a day in two", () => {
    const headers = turnDateHeaders(
      [turn(0, at(2024, 5, 20, 9)), turn(1, undefined), turn(2, at(2024, 5, 20, 14))],
      LABELS
    )
    expect([...headers.keys()]).toEqual([0])
  })

  it("opens a new day when the conversation resumes after a gap", () => {
    const headers = turnDateHeaders(
      [turn(0, at(2023, 1, 3)), turn(1, at(2024, 5, 19)), turn(2, at(2024, 5, 20))],
      LABELS
    )
    expect([...headers.keys()]).toEqual([0, 1, 2])
    expect(headers.get(1)).toBe("Yesterday")
    expect(headers.get(2)).toBe("Today")
  })

  it("skips a turn whose timestamp is unusable", () => {
    const headers = turnDateHeaders([turn(0, Number.NaN), turn(1, at(2024, 5, 20))], LABELS)
    expect([...headers.keys()]).toEqual([1])
  })
})

describe("dateHeaderAtOrBefore", () => {
  // The panel pins this above the virtualized list: inline headers there sit
  // inside `transform`-positioned rows, and a transformed ancestor becomes the
  // containing block for `position: sticky` — so they stick to their own 40px
  // row, i.e. not at all.
  const headers = new Map([
    [0, "Jan 3"],
    [4, "Yesterday"],
    [9, "Today"],
  ])

  it("returns the header on the row that opens the day", () => {
    expect(dateHeaderAtOrBefore(headers, 4)).toBe("Yesterday")
  })

  it("carries the day forward across rows that have no header of their own", () => {
    expect(dateHeaderAtOrBefore(headers, 5)).toBe("Yesterday")
    expect(dateHeaderAtOrBefore(headers, 8)).toBe("Yesterday")
    expect(dateHeaderAtOrBefore(headers, 100)).toBe("Today")
  })

  it("returns null before the first header, rather than guessing a day", () => {
    expect(dateHeaderAtOrBefore(new Map([[3, "Today"]]), 2)).toBeNull()
    expect(dateHeaderAtOrBefore(new Map(), 0)).toBeNull()
  })
})
