/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, _vars?: Record<string, unknown>) => key,
}))

import { SchedulerUpcomingRail } from "./scheduler-upcoming-rail"

const NOW = 1_800_000_000_000

function makeItem(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  const kind: ScheduledItemKind = overrides.kind ?? "app"
  const sourceId = overrides.sourceId ?? "task-1"
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name: "Daily summary",
    status: "active",
    triggerSummary: { type: "cron", cron: "0 9 * * *" },
    nextRunAt: NOW + 600_000,
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  } as UnifiedScheduledItem
}

function makeRun(overrides: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  return {
    unifiedId: "app:run-1",
    kind: "app",
    itemUnifiedId: "app:task-1",
    itemName: "Cross-kind run",
    status: "succeeded",
    startedAt: NOW - 60_000,
    origin: { tableName: "schedulerDb.executions", nativeId: "run-1" },
    ...overrides,
  } as UnifiedExecutionRun
}

describe("SchedulerUpcomingRail", () => {
  it("renders both sections with empty-state copy", () => {
    render(
      <SchedulerUpcomingRail
        items={[]}
        recentRuns={[]}
        onSelectItem={jest.fn()}
        onSelectRun={jest.fn()}
        now={NOW}
      />
    )
    expect(screen.getByTestId("scheduler-upcoming-rail")).toBeInTheDocument()
    expect(screen.getByTestId("upcoming-rail-no-upcoming")).toBeInTheDocument()
    expect(screen.getByTestId("upcoming-rail-no-recent")).toBeInTheDocument()
  })

  it("lists at most 5 upcoming items and fires onSelectItem with the unifiedId", () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      makeItem({ sourceId: `task-${i}`, name: `Task ${i}`, nextRunAt: NOW + (i + 1) * 60_000 })
    )
    const onSelectItem = jest.fn()
    render(
      <SchedulerUpcomingRail
        items={items}
        recentRuns={[]}
        onSelectItem={onSelectItem}
        onSelectRun={jest.fn()}
        now={NOW}
      />
    )
    expect(screen.getAllByRole("button")).toHaveLength(5)
    fireEvent.click(screen.getByTestId("upcoming-rail-upcoming-app:task-2"))
    expect(onSelectItem).toHaveBeenCalledWith("app:task-2")
  })

  it("draws upcoming rows from every source, soonest first", () => {
    const items = [
      makeItem({ kind: "backup", sourceId: "bk", name: "Backup", nextRunAt: NOW + 20_000 }),
      makeItem({ kind: "workflow", sourceId: "wf", name: "ETL", nextRunAt: NOW + 10_000 }),
    ]
    render(
      <SchedulerUpcomingRail
        items={items}
        recentRuns={[]}
        onSelectItem={jest.fn()}
        onSelectRun={jest.fn()}
        now={NOW}
      />
    )
    const rows = screen.getAllByRole("button")
    expect(rows[0]).toHaveAttribute("data-testid", "upcoming-rail-upcoming-workflow:wf")
    expect(rows[1]).toHaveAttribute("data-testid", "upcoming-rail-upcoming-backup:bk")
  })

  it("omits paused items — a paused item has no next run", () => {
    render(
      <SchedulerUpcomingRail
        items={[makeItem({ sourceId: "p1", status: "paused", name: "Paused" })]}
        recentRuns={[]}
        onSelectItem={jest.fn()}
        onSelectRun={jest.fn()}
        now={NOW}
      />
    )
    expect(screen.getByTestId("upcoming-rail-no-upcoming")).toBeInTheDocument()
  })

  it("lists the recent runs it is given and opens one on click", () => {
    const runs = [makeRun({ unifiedId: "app:run-x", itemName: "Unified run" })]
    const onSelectRun = jest.fn()
    render(
      <SchedulerUpcomingRail
        items={[]}
        recentRuns={runs}
        onSelectItem={jest.fn()}
        onSelectRun={onSelectRun}
        now={NOW}
      />
    )
    const row = screen.getByTestId("upcoming-rail-recent-app:run-x")
    expect(row).toHaveTextContent("Unified run")
    fireEvent.click(row)
    expect(onSelectRun).toHaveBeenCalledWith(runs[0])
  })

  it("caps the recent list at 5 rows", () => {
    const runs = Array.from({ length: 8 }, (_, i) => makeRun({ unifiedId: `app:run-${i}` }))
    render(
      <SchedulerUpcomingRail
        items={[]}
        recentRuns={runs}
        onSelectItem={jest.fn()}
        onSelectRun={jest.fn()}
        now={NOW}
      />
    )
    expect(screen.getAllByRole("button")).toHaveLength(5)
  })

  it("paints status dots by run status", () => {
    const runs = [
      makeRun({ unifiedId: "k:1", status: "succeeded" }),
      makeRun({ unifiedId: "k:2", status: "failed" }),
      makeRun({ unifiedId: "k:3", status: "running" }),
      makeRun({ unifiedId: "k:4", status: "cancelled" }),
    ]
    render(
      <SchedulerUpcomingRail
        items={[]}
        recentRuns={runs}
        onSelectItem={jest.fn()}
        onSelectRun={jest.fn()}
        now={NOW}
      />
    )
    expect(
      screen.getByTestId("upcoming-rail-recent-k:1").querySelector(".bg-green-500")
    ).toBeInTheDocument()
    expect(
      screen.getByTestId("upcoming-rail-recent-k:2").querySelector(".bg-red-500")
    ).toBeInTheDocument()
    expect(
      screen.getByTestId("upcoming-rail-recent-k:3").querySelector(".bg-blue-500")
    ).toBeInTheDocument()
    expect(
      screen.getByTestId("upcoming-rail-recent-k:4").querySelector(".bg-muted-foreground\\/40")
    ).toBeInTheDocument()
  })
})
