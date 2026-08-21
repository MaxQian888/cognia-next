/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

import { SchedulerCalendarView, buildMonthMatrix } from "./scheduler-calendar-view"
import type {
  ScheduledItemKind,
  UnifiedScheduledItem,
  UnifiedTriggerSummary,
} from "@/types/scheduler/unified"

const FROM = new Date(2026, 0, 5, 0, 0, 0, 0) // 2026-01-05 (Monday)

function item(
  sourceId: string,
  name: string,
  triggerSummary: UnifiedTriggerSummary,
  kind: ScheduledItemKind = "app"
): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name,
    status: "active",
    triggerSummary,
    successCount: 0,
    failureCount: 0,
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

describe("buildMonthMatrix", () => {
  it("returns a 6×7 Monday-first matrix", () => {
    const cells = buildMonthMatrix(2026, 0) // January 2026
    expect(cells).toHaveLength(42)
    // Jan 1 2026 is a Thursday → Monday-first grid starts on Dec 29 2025.
    expect(cells[0].date.getDate()).toBe(29)
    expect(cells[0].date.getMonth()).toBe(11)
    expect(cells[0].inMonth).toBe(false)
    const jan5 = cells.find((c) => c.date.getMonth() === 0 && c.date.getDate() === 5)
    expect(jan5?.inMonth).toBe(true)
  })
})

describe("SchedulerCalendarView", () => {
  it("renders the grid and shows density on a day with runs", () => {
    const items = [item("daily", "Daily Brief", { type: "cron", cron: "0 9 * * *" })]
    render(<SchedulerCalendarView items={items} onSelectItem={jest.fn()} now={FROM} />)
    expect(screen.getByTestId("scheduler-calendar-view")).toBeInTheDocument()
    expect(screen.getByTestId("calendar-day-2026-01-05")).toBeInTheDocument()
    // Today is selected by default → its 09:00 run is listed in the day panel.
    expect(screen.getByTestId("calendar-occ-app:daily")).toBeInTheDocument()
  })

  it("projects every source, not just app tasks", () => {
    const items = [
      item("daily", "Daily Brief", { type: "cron", cron: "0 9 * * *" }, "app"),
      item("etl", "Nightly ETL", { type: "cron", cron: "0 10 * * *" }, "workflow"),
      item("bk", "Backup", { type: "cron", cron: "0 11 * * *" }, "backup"),
    ]
    render(<SchedulerCalendarView items={items} onSelectItem={jest.fn()} now={FROM} />)
    expect(screen.getByTestId("calendar-occ-app:daily")).toBeInTheDocument()
    expect(screen.getByTestId("calendar-occ-workflow:etl")).toBeInTheDocument()
    expect(screen.getByTestId("calendar-occ-backup:bk")).toBeInTheDocument()
  })

  it("dispatches onSelectItem with the unifiedId when a day-panel run is clicked", () => {
    const onSelectItem = jest.fn()
    const items = [item("etl", "Nightly ETL", { type: "cron", cron: "0 9 * * *" }, "workflow")]
    render(<SchedulerCalendarView items={items} onSelectItem={onSelectItem} now={FROM} />)
    fireEvent.click(screen.getByTestId("calendar-occ-workflow:etl"))
    expect(onSelectItem).toHaveBeenCalledWith("workflow:etl")
  })

  it("shows the no-runs message for a day without runs", () => {
    const items = [item("daily", "Daily Brief", { type: "cron", cron: "0 9 * * *" })]
    render(<SchedulerCalendarView items={items} onSelectItem={jest.fn()} now={FROM} />)
    // Jan 6 has a run too (daily), so pick a clearly empty future-of-month day:
    // select Jan 31 — daily still fires, so instead select a leading out-of-month
    // day in the past (Dec 29) which has no future runs.
    fireEvent.click(screen.getByTestId("calendar-day-2025-12-29"))
    expect(screen.getByText("calendar.noRuns")).toBeInTheDocument()
  })

  it("defaults to the real clock when no `now` is injected", () => {
    render(<SchedulerCalendarView items={[]} onSelectItem={jest.fn()} />)
    expect(screen.getByTestId("scheduler-calendar-view")).toBeInTheDocument()
    expect(screen.getByText("calendar.noRuns")).toBeInTheDocument()
  })

  it("caps the density dots and reports the overflow count", () => {
    // Hourly cron → 24 runs on the selected day, well past the 3-dot cap.
    const items = [item("hourly", "Hourly", { type: "cron", cron: "0 * * * *" })]
    render(<SchedulerCalendarView items={items} onSelectItem={jest.fn()} now={FROM} />)
    const density = screen.getAllByTestId("calendar-density")[0]
    expect(density.textContent).toMatch(/^\+\d+$/)
    // …and the day panel still shows the item once, not 24 times.
    expect(screen.getAllByTestId("calendar-occ-app:hourly")).toHaveLength(1)
  })

  it("navigates months", () => {
    const items = [item("daily", "Daily Brief", { type: "cron", cron: "0 9 * * *" })]
    render(<SchedulerCalendarView items={items} onSelectItem={jest.fn()} now={FROM} />)
    fireEvent.click(screen.getByTestId("calendar-next-month"))
    // February 2026 grid → Feb 1 cell present.
    expect(screen.getByTestId("calendar-day-2026-02-01")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("calendar-prev-month"))
    expect(screen.getByTestId("calendar-day-2026-01-05")).toBeInTheDocument()
    // Stepping back past "now" leaves a grid with no projected runs.
    fireEvent.click(screen.getByTestId("calendar-prev-month"))
    expect(screen.getByTestId("calendar-day-2025-12-01")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("calendar-today"))
    expect(screen.getByTestId("calendar-day-2026-01-05")).toBeInTheDocument()
  })
})
