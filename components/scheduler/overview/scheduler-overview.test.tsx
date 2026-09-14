import { fireEvent, render, screen } from "@testing-library/react"

import { SchedulerOverview, type SchedulerOverviewProps } from "./scheduler-overview"
import { buildAgenda } from "@/lib/scheduler/agenda"
import { buildOutcomeCells } from "@/lib/scheduler/outcome-strip"
import { deriveUnifiedStatistics } from "@/lib/scheduler/unified-filter"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

const now = new Date(2026, 8, 13, 9).getTime()

function item(name: string, kind: UnifiedScheduledItem["kind"] = "app"): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${name}`,
    kind,
    sourceId: name,
    name,
    status: "active",
    triggerSummary: { type: "interval", intervalMs: 3_600_000 },
    nextRunAt: now + 600_000,
    successCount: 3,
    failureCount: 1,
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

function run(id: string, status: UnifiedExecutionRun["status"]): UnifiedExecutionRun {
  return {
    unifiedId: `app:${id}`,
    kind: "app",
    itemUnifiedId: "app:a",
    itemName: "a",
    status,
    startedAt: now - 60_000,
    durationMs: 500,
    origin: { tableName: "t", nativeId: id },
  }
}

function props(over: Partial<SchedulerOverviewProps> = {}): SchedulerOverviewProps {
  const items = [item("a"), item("b", "workflow")]
  const runs = [run("r1", "succeeded"), run("r2", "failed"), run("r3", "running")]
  return {
    signals: [],
    statistics: deriveUnifiedStatistics(items),
    outcomeCells: buildOutcomeCells(runs, { now, days: 14 }),
    agenda: buildAgenda(items, { now, days: 14 }),
    agendaDays: 14,
    now,
    recentRuns: runs,
    runningCount: 1,
    selectedKinds: new Set(),
    onToggleKind: jest.fn(),
    onSelectItem: jest.fn(),
    onOpenRun: jest.fn(),
    onCancelRun: jest.fn(),
    ...over,
  }
}

describe("SchedulerOverview", () => {
  it("renders every section once with numbers from the same inputs", () => {
    const p = props()
    render(<SchedulerOverview {...p} />)
    expect(screen.getByTestId("attention-empty")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-stat-active")).toHaveTextContent("2/2")
    expect(screen.getByTestId("scheduler-stat-runs")).toHaveTextContent("2")
    expect(screen.getByTestId("scheduler-stat-successRate")).toHaveTextContent("50%")
    expect(screen.getByTestId("scheduler-stat-running")).toHaveTextContent("1")
    expect(screen.getAllByTestId("scheduler-overview-outcomes-cell")).toHaveLength(14)
    expect(screen.getByTestId("agenda")).toBeInTheDocument()
    expect(screen.getByTestId("kind-summary")).toBeInTheDocument()
    expect(screen.getAllByTestId(/^run-row-app:/)).toHaveLength(3)
    fireEvent.click(screen.getByTestId("kind-summary-workflow"))
    expect(p.onToggleKind).toHaveBeenCalledWith("workflow")
  })

  it("lists signals in the attention section and wires its actions", () => {
    const onCancelRun = jest.fn()
    render(
      <SchedulerOverview
        {...props({
          signals: [
            {
              id: "running:app:a",
              kind: "running",
              severity: "info",
              itemUnifiedId: "app:a",
              itemName: "a",
              runUnifiedId: "app:r3",
            },
          ],
          attentionActions: { onCancelRun },
        })}
      />
    )
    expect(screen.getByTestId("console-section-attention")).toHaveTextContent("1")
    fireEvent.click(screen.getByTestId("attention-stop"))
    expect(onCancelRun).toHaveBeenCalledWith("app:r3")
  })

  it("says when nothing has run", () => {
    render(
      <SchedulerOverview
        {...props({
          recentRuns: [],
          runningCount: 0,
          outcomeCells: buildOutcomeCells([], { now }),
        })}
      />
    )
    expect(screen.getByTestId("scheduler-overview-no-runs")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-stat-successRate")).toHaveTextContent("—")
  })
})
