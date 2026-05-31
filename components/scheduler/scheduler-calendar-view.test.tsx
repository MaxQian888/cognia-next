/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

import { SchedulerCalendarView, buildMonthMatrix } from "./scheduler-calendar-view"
import type { ScheduledTask, TaskTrigger } from "@/types/scheduler"

const FROM = new Date(2026, 0, 5, 0, 0, 0, 0) // 2026-01-05 (Monday)

function task(id: string, name: string, trigger: TaskTrigger): ScheduledTask {
  return {
    id,
    name,
    type: "chat",
    status: "active",
    trigger,
    config: {
      timeout: 1,
      maxRetries: 0,
      retryDelay: 0,
      runMissedOnStartup: false,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: false, onError: false },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
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
    const tasks = [task("daily", "Daily Brief", { type: "cron", cronExpression: "0 9 * * *" })]
    render(<SchedulerCalendarView tasks={tasks} onSelectTask={jest.fn()} now={FROM} />)
    expect(screen.getByTestId("scheduler-calendar-view")).toBeInTheDocument()
    expect(screen.getByTestId("calendar-day-2026-01-05")).toBeInTheDocument()
    // Today is selected by default → its 09:00 run is listed in the day panel.
    expect(screen.getByTestId("calendar-occ-daily")).toBeInTheDocument()
  })

  it("dispatches onSelectTask when a day-panel run is clicked", () => {
    const onSelectTask = jest.fn()
    const tasks = [task("daily", "Daily Brief", { type: "cron", cronExpression: "0 9 * * *" })]
    render(<SchedulerCalendarView tasks={tasks} onSelectTask={onSelectTask} now={FROM} />)
    fireEvent.click(screen.getByTestId("calendar-occ-daily"))
    expect(onSelectTask).toHaveBeenCalledWith("daily")
  })

  it("shows the no-runs message for a day without runs", () => {
    const tasks = [task("daily", "Daily Brief", { type: "cron", cronExpression: "0 9 * * *" })]
    render(<SchedulerCalendarView tasks={tasks} onSelectTask={jest.fn()} now={FROM} />)
    // Jan 6 has a run too (daily), so pick a clearly empty future-of-month day:
    // select Jan 31 — daily still fires, so instead select a leading out-of-month
    // day in the past (Dec 29) which has no future runs.
    fireEvent.click(screen.getByTestId("calendar-day-2025-12-29"))
    expect(screen.getByText("calendar.noRuns")).toBeInTheDocument()
  })

  it("navigates months", () => {
    const tasks = [task("daily", "Daily Brief", { type: "cron", cronExpression: "0 9 * * *" })]
    render(<SchedulerCalendarView tasks={tasks} onSelectTask={jest.fn()} now={FROM} />)
    fireEvent.click(screen.getByTestId("calendar-next-month"))
    // February 2026 grid → Feb 1 cell present.
    expect(screen.getByTestId("calendar-day-2026-02-01")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("calendar-today"))
    expect(screen.getByTestId("calendar-day-2026-01-05")).toBeInTheDocument()
  })
})
