/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

import { SchedulerTimelineView } from "./scheduler-timeline-view"
import type { ScheduledTask, TaskTrigger } from "@/types/scheduler"

const FROM = new Date(2026, 0, 5, 0, 0, 0, 0)

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

describe("SchedulerTimelineView", () => {
  it("renders day-grouped occurrences", () => {
    const tasks = [task("daily", "Daily Brief", { type: "cron", cronExpression: "0 9 * * *" })]
    render(
      <SchedulerTimelineView tasks={tasks} onSelectTask={jest.fn()} now={FROM} windowDays={3} />
    )
    expect(screen.getByTestId("scheduler-timeline-view")).toBeInTheDocument()
    // First day section is "today".
    expect(screen.getByTestId("timeline-day-2026-01-05")).toBeInTheDocument()
    expect(screen.getAllByText("Daily Brief").length).toBeGreaterThan(0)
  })

  it("dispatches onSelectTask when a row is clicked", () => {
    const onSelectTask = jest.fn()
    const tasks = [task("daily", "Daily Brief", { type: "cron", cronExpression: "0 9 * * *" })]
    render(
      <SchedulerTimelineView tasks={tasks} onSelectTask={onSelectTask} now={FROM} windowDays={2} />
    )
    fireEvent.click(screen.getAllByTestId("timeline-occ-daily")[0])
    expect(onSelectTask).toHaveBeenCalledWith("daily")
  })

  it("renders the empty state when no upcoming runs", () => {
    render(<SchedulerTimelineView tasks={[]} onSelectTask={jest.fn()} now={FROM} />)
    expect(screen.getByTestId("scheduler-timeline-empty")).toBeInTheDocument()
  })
})
