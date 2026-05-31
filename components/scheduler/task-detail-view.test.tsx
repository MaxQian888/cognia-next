/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub heavy sub-components.
jest.mock("./task-stats-cards", () => ({
  __esModule: true,
  TaskStatsCards: () => <div data-testid="task-stats-cards-stub" />,
}))
jest.mock("./task-execution-chart", () => ({
  __esModule: true,
  TaskExecutionChart: () => <div data-testid="task-execution-chart-stub" />,
}))
jest.mock("./task-execution-history", () => ({
  __esModule: true,
  TaskExecutionHistory: () => <div data-testid="task-execution-history-stub" />,
}))
jest.mock("./task-configuration", () => ({
  __esModule: true,
  TaskConfiguration: () => <div data-testid="task-configuration-stub" />,
}))
jest.mock("./task-notification-display", () => ({
  __esModule: true,
  TaskNotificationDisplay: () => <div data-testid="task-notification-display-stub" />,
}))
jest.mock("./task-tags-display", () => ({
  __esModule: true,
  TaskTagsDisplay: () => <div data-testid="task-tags-display-stub" />,
}))

// Stub Radix DropdownMenu and Tooltip to render inline.
jest.mock("@/components/ui/dropdown-menu")

jest.mock("@/components/ui/tooltip")

jest.mock("@/components/ui/scroll-area")

import { TaskDetailView } from "./task-detail-view"
import type { ScheduledTask } from "@/types/scheduler"

function buildTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "My task",
    description: "A description",
    type: "custom",
    status: "active",
    trigger: { type: "cron", cronExpression: "* * * * *" },
    payload: {},
    config: {},
    notification: { enabled: false },
    tags: ["a"],
    ...overrides,
  } as unknown as ScheduledTask
}

function callbacks() {
  return {
    onPause: jest.fn(),
    onResume: jest.fn(),
    onRunNow: jest.fn(),
    onDelete: jest.fn(),
    onEdit: jest.fn(),
  }
}

describe("TaskDetailView", () => {
  it("renders the task name and description", () => {
    const cbs = callbacks()
    render(<TaskDetailView task={buildTask()} executions={[]} {...cbs} />)
    expect(screen.getByText("My task")).toBeInTheDocument()
    expect(screen.getByText("A description")).toBeInTheDocument()
  })

  it("omits the description when not provided", () => {
    const cbs = callbacks()
    render(<TaskDetailView task={buildTask({ description: "" })} executions={[]} {...cbs} />)
    expect(screen.queryByText("A description")).toBeNull()
  })

  it("dispatches onRunNow when the Run button is clicked", () => {
    const cbs = callbacks()
    render(<TaskDetailView task={buildTask()} executions={[]} {...cbs} />)
    fireEvent.click(screen.getByLabelText("runNow"))
    expect(cbs.onRunNow).toHaveBeenCalledWith("t1")
  })

  it("dispatches onPause when status is active", () => {
    const cbs = callbacks()
    render(<TaskDetailView task={buildTask({ status: "active" })} executions={[]} {...cbs} />)
    fireEvent.click(screen.getByLabelText("pause"))
    expect(cbs.onPause).toHaveBeenCalledWith("t1")
  })

  it("swaps Pause for Resume when paused and dispatches onResume", () => {
    const cbs = callbacks()
    render(<TaskDetailView task={buildTask({ status: "paused" })} executions={[]} {...cbs} />)
    fireEvent.click(screen.getByLabelText("resume"))
    expect(cbs.onResume).toHaveBeenCalledWith("t1")
  })

  it("dispatches onEdit when the Edit button is clicked", () => {
    const cbs = callbacks()
    render(<TaskDetailView task={buildTask()} executions={[]} {...cbs} />)
    fireEvent.click(screen.getByLabelText("edit"))
    expect(cbs.onEdit).toHaveBeenCalled()
  })

  it("dispatches onDelete from the More menu", () => {
    const cbs = callbacks()
    render(<TaskDetailView task={buildTask()} executions={[]} {...cbs} />)
    fireEvent.click(screen.getByText("delete"))
    expect(cbs.onDelete).toHaveBeenCalledWith("t1")
  })

  it("renders all six composite sub-components", () => {
    const cbs = callbacks()
    render(<TaskDetailView task={buildTask()} executions={[]} {...cbs} />)
    expect(screen.getByTestId("task-stats-cards-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-execution-chart-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-execution-history-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-configuration-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-notification-display-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-tags-display-stub")).toBeInTheDocument()
  })

  it("renders status badges for known statuses with the right class", () => {
    const cbs = callbacks()
    for (const status of ["active", "paused", "disabled", "expired"] as const) {
      const { unmount } = render(
        <TaskDetailView task={buildTask({ status })} executions={[]} {...cbs} />
      )
      expect(screen.getByText(`statuses.${status}`)).toBeInTheDocument()
      unmount()
    }
  })

  it("handles tags array missing", () => {
    const cbs = callbacks()
    render(
      <TaskDetailView
        task={buildTask({ tags: undefined as unknown as string[] })}
        executions={[]}
        {...cbs}
      />
    )
    expect(screen.getByTestId("task-tags-display-stub")).toBeInTheDocument()
  })

  describe("dependencies card", () => {
    const focus = buildTask({
      id: "t1",
      trigger: { type: "cron", cronExpression: "* * * * *", dependsOn: ["up"] },
    })
    const up = buildTask({ id: "up", name: "Upstream" })
    const down = buildTask({
      id: "down",
      name: "Downstream",
      trigger: { type: "cron", cronExpression: "* * * * *", dependsOn: ["t1"] },
    })
    const allTasks = [focus, up, down]

    it("is omitted when allTasks is not provided", () => {
      const cbs = callbacks()
      render(<TaskDetailView task={focus} executions={[]} {...cbs} />)
      expect(screen.queryByTestId("task-dependencies-card")).toBeNull()
    })

    it("is omitted when the task has no dependency links", () => {
      const cbs = callbacks()
      const solo = buildTask({ id: "solo", trigger: { type: "cron", cronExpression: "* * * * *" } })
      render(<TaskDetailView task={solo} executions={[]} allTasks={[solo]} {...cbs} />)
      expect(screen.queryByTestId("task-dependencies-card")).toBeNull()
    })

    it("renders the neighborhood graph when the task has links", () => {
      const cbs = callbacks()
      render(<TaskDetailView task={focus} executions={[]} allTasks={allTasks} {...cbs} />)
      expect(screen.getByTestId("task-dependencies-card")).toBeInTheDocument()
      expect(screen.getByTestId("dependency-node-t1")).toBeInTheDocument()
      expect(screen.getByTestId("dependency-node-up")).toBeInTheDocument()
      expect(screen.getByTestId("dependency-node-down")).toBeInTheDocument()
    })

    it("opens the full graph dialog via the button", () => {
      const cbs = callbacks()
      const onOpenDependencyGraph = jest.fn()
      render(
        <TaskDetailView
          task={focus}
          executions={[]}
          allTasks={allTasks}
          onOpenDependencyGraph={onOpenDependencyGraph}
          {...cbs}
        />
      )
      fireEvent.click(screen.getByTestId("open-dependency-graph"))
      expect(onOpenDependencyGraph).toHaveBeenCalled()
    })

    it("navigates when a dependency node is clicked", () => {
      const cbs = callbacks()
      const onSelectTask = jest.fn()
      render(
        <TaskDetailView
          task={focus}
          executions={[]}
          allTasks={allTasks}
          onSelectTask={onSelectTask}
          {...cbs}
        />
      )
      fireEvent.click(screen.getByTestId("dependency-node-up"))
      expect(onSelectTask).toHaveBeenCalledWith("up")
    })
  })
})
