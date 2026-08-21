/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

import { SchedulerTimelineView } from "./scheduler-timeline-view"
import type {
  ScheduledItemKind,
  UnifiedScheduledItem,
  UnifiedTriggerSummary,
} from "@/types/scheduler/unified"

const FROM = new Date(2026, 0, 5, 0, 0, 0, 0)

function item(
  sourceId: string,
  name: string,
  triggerSummary: UnifiedTriggerSummary,
  kind: ScheduledItemKind = "app",
  overrides: Partial<UnifiedScheduledItem> = {}
): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name,
    status: "active",
    triggerSummary,
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

describe("SchedulerTimelineView", () => {
  it("renders day-grouped occurrences", () => {
    const items = [item("daily", "Daily Brief", { type: "cron", cron: "0 9 * * *" })]
    render(
      <SchedulerTimelineView items={items} onSelectItem={jest.fn()} now={FROM} windowDays={3} />
    )
    expect(screen.getByTestId("scheduler-timeline-view")).toBeInTheDocument()
    // First day section is "today".
    expect(screen.getByTestId("timeline-day-2026-01-05")).toBeInTheDocument()
    expect(screen.getAllByText("Daily Brief").length).toBeGreaterThan(0)
  })

  it("agendas every source, not just app tasks", () => {
    const items = [
      item("daily", "Daily Brief", { type: "cron", cron: "0 9 * * *" }, "app"),
      item("etl", "Nightly ETL", { type: "cron", cron: "0 10 * * *" }, "workflow"),
      item("queue", "Outbound queue", { type: "cron", cron: "0 11 * * *" }, "connector"),
    ]
    render(
      <SchedulerTimelineView items={items} onSelectItem={jest.fn()} now={FROM} windowDays={2} />
    )
    expect(screen.getAllByTestId("timeline-occ-app:daily").length).toBeGreaterThan(0)
    expect(screen.getAllByTestId("timeline-occ-workflow:etl").length).toBeGreaterThan(0)
    expect(screen.getAllByTestId("timeline-occ-connector:queue").length).toBeGreaterThan(0)
  })

  it("includes an item whose trigger cannot be expanded but has a known next run", () => {
    const items = [
      item("os", "OS health check", { type: "event", eventType: "os" }, "system", {
        nextRunAt: FROM.getTime() + 4 * 60 * 60 * 1000,
      }),
    ]
    render(
      <SchedulerTimelineView items={items} onSelectItem={jest.fn()} now={FROM} windowDays={2} />
    )
    expect(screen.getByTestId("timeline-occ-system:os")).toBeInTheDocument()
  })

  it("dispatches onSelectItem with the unifiedId when a row is clicked", () => {
    const onSelectItem = jest.fn()
    const items = [item("etl", "Nightly ETL", { type: "cron", cron: "0 9 * * *" }, "workflow")]
    render(
      <SchedulerTimelineView items={items} onSelectItem={onSelectItem} now={FROM} windowDays={2} />
    )
    fireEvent.click(screen.getAllByTestId("timeline-occ-workflow:etl")[0])
    expect(onSelectItem).toHaveBeenCalledWith("workflow:etl")
  })

  it("skips paused items — a paused trigger has no next run", () => {
    const items = [
      item("daily", "Daily Brief", { type: "cron", cron: "0 9 * * *" }, "app", {
        status: "paused",
      }),
    ]
    render(
      <SchedulerTimelineView items={items} onSelectItem={jest.fn()} now={FROM} windowDays={3} />
    )
    expect(screen.getByTestId("scheduler-timeline-empty")).toBeInTheDocument()
  })

  it("renders the empty state when no upcoming runs", () => {
    render(<SchedulerTimelineView items={[]} onSelectItem={jest.fn()} now={FROM} />)
    expect(screen.getByTestId("scheduler-timeline-empty")).toBeInTheDocument()
  })
})
