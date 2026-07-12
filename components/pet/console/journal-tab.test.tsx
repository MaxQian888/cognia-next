import { render, screen } from "@testing-library/react"

// Reactive ledger read — a controllable snapshot instead of a live Dexie.
let rowsValue: unknown
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => rowsValue,
}))

import { JournalTab, groupByLocalDay } from "./journal-tab"
import type { PetActivityRow } from "@/types/pet"

const NOON_JUL2 = new Date("2026-07-02T12:00:00").getTime()
const NOON_JUL1 = new Date("2026-07-01T12:00:00").getTime()

function row(over: Partial<PetActivityRow>): PetActivityRow {
  return { id: 1, kind: "fed", source: "user", xp: 3, ts: NOON_JUL2, ...over }
}

beforeEach(() => {
  rowsValue = []
})

describe("groupByLocalDay", () => {
  it("groups newest-first rows into contiguous day sections with XP totals", () => {
    const groups = groupByLocalDay([
      row({ id: 3, ts: NOON_JUL2 + 60_000, xp: 4, kind: "played" }),
      row({ id: 2, ts: NOON_JUL2, xp: 3 }),
      row({ id: 1, ts: NOON_JUL1, xp: 25, kind: "goalComplete" }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].day).toBe("2026-07-02")
    expect(groups[0].rows).toHaveLength(2)
    expect(groups[0].totalXp).toBe(7)
    expect(groups[1].day).toBe("2026-07-01")
    expect(groups[1].totalXp).toBe(25)
  })

  it("returns nothing for an empty ledger", () => {
    expect(groupByLocalDay([])).toEqual([])
  })
})

describe("JournalTab", () => {
  it("shows the loading state while the query is pending", () => {
    rowsValue = undefined
    render(<JournalTab />)
    expect(screen.getByTestId("pet-journal-loading")).toBeInTheDocument()
  })

  it("shows the empty state for a fresh ledger", () => {
    rowsValue = []
    render(<JournalTab />)
    expect(screen.getByTestId("pet-journal-empty")).toBeInTheDocument()
  })

  it("renders day sections with entries, labels, and XP badges", () => {
    rowsValue = [
      row({ id: 3, ts: NOON_JUL2 + 60_000, xp: 4, kind: "played" }),
      row({ id: 2, ts: NOON_JUL2, xp: 3 }),
      row({ id: 1, ts: NOON_JUL1, xp: 25, kind: "goalComplete" }),
    ]
    render(<JournalTab />)
    const days = document.querySelectorAll("[data-journal-day]")
    expect(days).toHaveLength(2)
    expect(days[0].getAttribute("data-journal-day")).toBe("2026-07-02")
    expect(document.querySelectorAll("[data-journal-entry]")).toHaveLength(3)
    // Known kinds render their authored labels.
    expect(screen.getByText("Played together")).toBeInTheDocument()
    expect(screen.getByText("Celebrated a finished goal")).toBeInTheDocument()
    // XP badge interpolates.
    expect(screen.getAllByText("+25 XP").length).toBeGreaterThan(0)
  })

  it("falls back to the raw kind for unknown ledger kinds", () => {
    rowsValue = [row({ id: 9, kind: "somePluginKind" as PetActivityRow["kind"] })]
    render(<JournalTab />)
    expect(screen.getByText("somePluginKind")).toBeInTheDocument()
  })
})
