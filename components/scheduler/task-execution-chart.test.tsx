/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// recharts is heavy and not needed for the bucketing logic — stub it.
jest.mock("recharts", () => ({
  __esModule: true,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ data, children }: { data: unknown[]; children: React.ReactNode }) => (
    <div data-testid="bar-chart" data-len={data.length}>
      {children}
    </div>
  ),
  Bar: ({ dataKey }: { dataKey: string }) => <div data-testid={`bar-${dataKey}`} />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  Tooltip: () => <div />,
  CartesianGrid: () => <div />,
}))

import {
  TaskExecutionChart,
  toChartPointsFromExecutions,
  toChartPointsFromUnifiedRuns,
} from "./task-execution-chart"
import type { TaskExecution } from "@/types/scheduler"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

function buildExec(overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: "e1",
    taskId: "t1",
    status: "completed",
    startedAt: new Date(),
    completedAt: new Date(),
    ...overrides,
  } as unknown as TaskExecution
}

function buildRun(overrides: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  return {
    unifiedId: "app:r1",
    kind: "app",
    itemUnifiedId: "app:t1",
    itemName: "Task",
    status: "succeeded",
    startedAt: Date.now(),
    ...overrides,
  } as UnifiedExecutionRun
}

describe("toChartPointsFromExecutions", () => {
  it("maps the three plotted statuses and drops the rest", () => {
    const points = toChartPointsFromExecutions([
      buildExec({ status: "completed" }),
      buildExec({ status: "failed" }),
      buildExec({ status: "running" }),
      buildExec({ status: "pending" } as Partial<TaskExecution>),
    ])
    expect(points.map((p) => p.outcome)).toEqual(["completed", "failed", "running"])
  })

  it("narrows to one task when a taskId is given", () => {
    const points = toChartPointsFromExecutions(
      [buildExec({ taskId: "t1" }), buildExec({ taskId: "other" })],
      "t1"
    )
    expect(points).toHaveLength(1)
  })
})

describe("toChartPointsFromUnifiedRuns", () => {
  it("maps every source's run outcomes onto the chart's three bands", () => {
    const points = toChartPointsFromUnifiedRuns([
      buildRun({ kind: "workflow", status: "succeeded" }),
      buildRun({ kind: "backup", status: "failed" }),
      buildRun({ kind: "connector", status: "running" }),
    ])
    expect(points.map((p) => p.outcome)).toEqual(["completed", "failed", "running"])
  })

  it("drops runs the three-band chart has no honest bucket for", () => {
    const points = toChartPointsFromUnifiedRuns([
      buildRun({ status: "cancelled" }),
      buildRun({ status: "skipped" }),
    ])
    expect(points).toEqual([])
  })
})

describe("TaskExecutionChart", () => {
  it("renders an empty state when there are no points", () => {
    render(<TaskExecutionChart runs={[]} />)
    expect(screen.getByTestId("task-execution-chart")).toBeInTheDocument()
    expect(screen.getByText(/noData|No execution data/)).toBeInTheDocument()
  })

  it("renders the chart with stacked bars when data is present", () => {
    render(
      <TaskExecutionChart
        runs={toChartPointsFromExecutions([
          buildExec({ status: "completed" }),
          buildExec({ status: "failed" }),
          buildExec({ status: "running" }),
        ])}
      />
    )
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument()
    expect(screen.getByTestId("bar-completed")).toBeInTheDocument()
    expect(screen.getByTestId("bar-failed")).toBeInTheDocument()
    expect(screen.getByTestId("bar-running")).toBeInTheDocument()
  })

  it("plots cross-source runs, not just app executions", () => {
    render(
      <TaskExecutionChart
        runs={toChartPointsFromUnifiedRuns([buildRun({ kind: "backup", status: "succeeded" })])}
      />
    )
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument()
  })

  it("forwards className", () => {
    const { container } = render(<TaskExecutionChart runs={[]} className="extra-class" />)
    expect(container.querySelector(".extra-class")).not.toBeNull()
  })

  it("ignores runs on dates older than 7 days", () => {
    render(
      <TaskExecutionChart
        runs={[{ startedAt: new Date("2000-01-01").getTime(), outcome: "completed" }]}
      />
    )
    // Result: empty bucket, so empty-state renders.
    expect(screen.getByText(/noData|No execution data/)).toBeInTheDocument()
  })
})
