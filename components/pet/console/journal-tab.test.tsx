import { act, fireEvent, render, screen } from "@testing-library/react"

// Reactive ledger read — a controllable snapshot instead of a live Dexie.
let rowsValue: unknown
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => rowsValue,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/lib/db/pet", () => ({
  listPetActivityPage: jest.fn(),
  listPetActivitySince: jest.fn(),
}))

import { toast } from "sonner"
import { listPetActivityPage } from "@/lib/db/pet"
import { JOURNAL_KIND_ICONS, JOURNAL_PAGE, JournalTab, groupByLocalDay } from "./journal-tab"
import en from "@/i18n/messages/en/pet.json"
import zh from "@/i18n/messages/zh-CN/pet.json"
import type { PetActivityRow } from "@/types/pet"

const pageMock = listPetActivityPage as jest.Mock

const NOON_JUL2 = new Date("2026-07-02T12:00:00").getTime()
const NOON_JUL1 = new Date("2026-07-01T12:00:00").getTime()

function row(over: Partial<PetActivityRow>): PetActivityRow {
  return { id: 1, kind: "fed", source: "user", xp: 3, ts: NOON_JUL2, ...over }
}

beforeEach(() => {
  rowsValue = []
  pageMock.mockReset()
  ;(toast.error as jest.Mock).mockClear()
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

  it("words an unknown ledger kind generically instead of showing its raw id", () => {
    rowsValue = [row({ id: 9, kind: "somePluginKind" as PetActivityRow["kind"] })]
    render(<JournalTab />)
    expect(screen.queryByText("somePluginKind")).toBeNull()
    expect(screen.getByText("Other activity")).toBeInTheDocument()
  })

  it.each([
    ["en", en],
    ["zh-CN", zh],
  ])("authors a label for every iconed kind in %s", (_locale, messages) => {
    const kinds = (messages as { journal: { kinds: Record<string, string> } }).journal.kinds
    for (const kind of [...Object.keys(JOURNAL_KIND_ICONS), "other"]) {
      expect(typeof kinds[kind]).toBe("string")
    }
  })

  it("offers no older page when the head page is not full", () => {
    rowsValue = [row({ id: 1 })]
    render(<JournalTab />)
    expect(screen.queryByTestId("pet-journal-load-older")).toBeNull()
  })

  it("loads older rows below the oldest one shown, until the ledger runs out", async () => {
    rowsValue = Array.from({ length: JOURNAL_PAGE }, (_, i) =>
      row({ id: 1000 - i, ts: NOON_JUL2 - i })
    )
    pageMock.mockResolvedValueOnce([row({ id: 5, ts: NOON_JUL1, kind: "played" })])
    render(<JournalTab />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("pet-journal-load-older"))
    })
    expect(pageMock).toHaveBeenCalledWith(1000 - JOURNAL_PAGE + 1, JOURNAL_PAGE)
    expect(screen.getByText("Played together")).toBeInTheDocument()
    // A short page means the start of the ledger was reached.
    expect(screen.queryByTestId("pet-journal-load-older")).toBeNull()
  })

  it("reports a failed older-page read", async () => {
    rowsValue = Array.from({ length: JOURNAL_PAGE }, (_, i) => row({ id: 1000 - i }))
    pageMock.mockRejectedValueOnce(new Error("closed"))
    render(<JournalTab />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("pet-journal-load-older"))
    })
    expect(toast.error).toHaveBeenCalled()
    expect(screen.getByTestId("pet-journal-load-older")).not.toBeDisabled()
  })
})
