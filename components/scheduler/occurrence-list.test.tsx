/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => "en",
}))

import { OccurrenceList, MAX_VISIBLE_TIMES } from "./occurrence-list"
import type { Occurrence } from "@/lib/scheduler/upcoming-occurrences"

function occ(taskId: string, taskName: string, hour: number, minute = 0): Occurrence {
  return {
    taskId,
    taskName,
    taskType: "chat",
    triggerType: "cron",
    status: "active",
    date: new Date(2026, 0, 5, hour, minute, 0, 0),
  }
}

describe("OccurrenceList", () => {
  it("collapses repeated runs of one task into a single row", () => {
    render(
      <OccurrenceList
        occurrences={[
          occ("t1", "Daily Brief", 9),
          occ("t1", "Daily Brief", 12),
          occ("t2", "Sync", 10),
        ]}
        onSelectTask={jest.fn()}
        testIdPrefix="timeline-occ"
      />
    )
    // One row per task, not one per run.
    expect(screen.getAllByText("Daily Brief")).toHaveLength(1)
    expect(screen.getByTestId("timeline-occ-t1")).toBeInTheDocument()
    expect(screen.getByTestId("timeline-occ-t2")).toBeInTheDocument()
  })

  it("prints each fire time of a collapsed row", () => {
    render(
      <OccurrenceList
        occurrences={[occ("t1", "Daily Brief", 9), occ("t1", "Daily Brief", 12)]}
        onSelectTask={jest.fn()}
        testIdPrefix="timeline-occ"
      />
    )
    const row = screen.getByTestId("timeline-occ-t1")
    expect(row.textContent).toContain("09:00")
    expect(row.textContent).toContain("12:00")
  })

  it("caps the printed times and reports the overflow", () => {
    const many = Array.from({ length: MAX_VISIBLE_TIMES + 3 }, (_, i) =>
      occ("t1", "Every 5m", 9, i * 5)
    )
    render(
      <OccurrenceList occurrences={many} onSelectTask={jest.fn()} testIdPrefix="calendar-occ" />
    )
    const overflow = screen.getByTestId("calendar-occ-t1-overflow")
    expect(overflow.textContent).toContain("occurrenceList.moreTimes")
    expect(overflow.textContent).toContain('"count":3')
  })

  it("drops an exact duplicate instant for the same task", () => {
    render(
      <OccurrenceList
        occurrences={[occ("t1", "Daily Brief", 9), occ("t1", "Daily Brief", 9)]}
        onSelectTask={jest.fn()}
        testIdPrefix="timeline-occ"
      />
    )
    const row = screen.getByTestId("timeline-occ-t1")
    expect(row.textContent?.match(/09:00/g)).toHaveLength(1)
    expect(screen.queryByTestId("timeline-occ-t1-overflow")).toBeNull()
  })

  it("dispatches onSelectTask when a row is clicked", () => {
    const onSelectTask = jest.fn()
    render(
      <OccurrenceList
        occurrences={[occ("t1", "Daily Brief", 9)]}
        onSelectTask={onSelectTask}
        testIdPrefix="timeline-occ"
      />
    )
    fireEvent.click(screen.getByTestId("timeline-occ-t1"))
    expect(onSelectTask).toHaveBeenCalledWith("t1")
  })

  it("labels each row with its name and run count", () => {
    render(
      <OccurrenceList
        occurrences={[occ("t1", "Daily Brief", 9), occ("t1", "Daily Brief", 12)]}
        onSelectTask={jest.fn()}
        testIdPrefix="timeline-occ"
      />
    )
    const label = screen.getByTestId("timeline-occ-t1").getAttribute("aria-label")
    expect(label).toContain("occurrenceList.rowAria")
    expect(label).toContain('"count":2')
    expect(label).toContain("Daily Brief")
  })

  it("renders the trigger-type label once per row", () => {
    render(
      <OccurrenceList
        occurrences={[occ("t1", "Daily Brief", 9), occ("t1", "Daily Brief", 12)]}
        onSelectTask={jest.fn()}
        testIdPrefix="timeline-occ"
      />
    )
    expect(screen.getAllByText("triggerTypes.cron")).toHaveLength(1)
  })

  it("renders nothing but the list shell for an empty input", () => {
    render(<OccurrenceList occurrences={[]} onSelectTask={jest.fn()} testIdPrefix="calendar-occ" />)
    expect(screen.getByTestId("calendar-occ-list").children).toHaveLength(0)
  })
})
