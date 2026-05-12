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

import { TaskExecutionChart } from "./task-execution-chart"
import type { TaskExecution } from "@/types/scheduler"

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

describe("TaskExecutionChart", () => {
  it("renders an empty state when no executions match", () => {
    render(<TaskExecutionChart executions={[]} />)
    expect(screen.getByTestId("task-execution-chart")).toBeInTheDocument()
    expect(screen.getByText(/noData|No execution data/)).toBeInTheDocument()
  })

  it("renders the chart with stacked bars when data is present", () => {
    const execs = [
      buildExec({ status: "completed" }),
      buildExec({ status: "failed" }),
      buildExec({ status: "running" }),
    ]
    render(<TaskExecutionChart executions={execs} />)
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument()
    expect(screen.getByTestId("bar-completed")).toBeInTheDocument()
    expect(screen.getByTestId("bar-failed")).toBeInTheDocument()
    expect(screen.getByTestId("bar-running")).toBeInTheDocument()
  })

  it("filters executions by taskId when provided", () => {
    const execs = [
      buildExec({ taskId: "t1", status: "completed" }),
      buildExec({ taskId: "other", status: "completed" }),
    ]
    render(<TaskExecutionChart executions={execs} taskId="t1" />)
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument()
  })

  it("renders the empty state when filtered taskId has no executions", () => {
    const execs = [buildExec({ taskId: "other", status: "completed" })]
    render(<TaskExecutionChart executions={execs} taskId="t1" />)
    expect(screen.getByText(/noData|No execution data/)).toBeInTheDocument()
  })

  it("forwards className", () => {
    const { container } = render(<TaskExecutionChart executions={[]} className="extra-class" />)
    expect(container.querySelector(".extra-class")).not.toBeNull()
  })

  it("ignores executions on dates older than 7 days", () => {
    // Old execution that won't fit any of the last-7-days buckets.
    const old = buildExec({ startedAt: new Date("2000-01-01"), status: "completed" })
    render(<TaskExecutionChart executions={[old]} />)
    // Result: empty bucket, so empty-state renders.
    expect(screen.getByText(/noData|No execution data/)).toBeInTheDocument()
  })
})
