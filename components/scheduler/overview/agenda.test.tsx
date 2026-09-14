import { fireEvent, render, screen } from "@testing-library/react"

import { Agenda } from "./agenda"
import { buildAgenda } from "@/lib/scheduler/agenda"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

const HOUR = 3_600_000
const DAY = 24 * HOUR

function item(name: string, nextRunAt: number, intervalMs = 12 * HOUR): UnifiedScheduledItem {
  return {
    unifiedId: `app:${name}`,
    kind: "app",
    sourceId: name,
    name,
    status: "active",
    triggerSummary: { type: "interval", intervalMs },
    nextRunAt,
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

describe("Agenda", () => {
  const now = new Date(2026, 8, 13, 9).getTime()

  it("renders a density row and day groups, and pins a day on click", () => {
    const agenda = buildAgenda(
      [item("poll", now + HOUR), item("later", now + DAY + HOUR, 7 * DAY)],
      {
        now,
        days: 3,
      }
    )
    const onSelectItem = jest.fn()
    render(<Agenda agenda={agenda} windowDays={3} now={now} onSelectItem={onSelectItem} />)
    const cells = screen.getAllByTestId("agenda-density-cell")
    expect(cells).toHaveLength(3)
    expect(Number(cells[0].dataset.count)).toBeGreaterThan(0)
    expect(screen.getByText("Today")).toBeInTheDocument()
    expect(screen.getByText("Tomorrow")).toBeInTheDocument()

    fireEvent.click(screen.getAllByTestId("agenda-occurrence")[0])
    expect(onSelectItem).toHaveBeenCalledWith("app:poll")

    fireEvent.click(cells[1])
    expect(cells[1]).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByText("Today")).not.toBeInTheDocument()
    expect(screen.getByText("Tomorrow")).toBeInTheDocument()
    fireEvent.click(cells[1])
    expect(screen.getByText("Today")).toBeInTheDocument()
  })

  it("says when nothing is scheduled, overall and for a pinned day", () => {
    const agenda = buildAgenda([], { now, days: 2 })
    render(<Agenda agenda={agenda} windowDays={2} now={now} onSelectItem={jest.fn()} />)
    expect(screen.getByTestId("agenda-empty")).toHaveTextContent(
      "Nothing scheduled in the next two weeks"
    )
    fireEvent.click(screen.getAllByTestId("agenda-density-cell")[0])
    expect(screen.getByTestId("agenda-empty")).toHaveTextContent("Nothing scheduled that day")
  })
})
