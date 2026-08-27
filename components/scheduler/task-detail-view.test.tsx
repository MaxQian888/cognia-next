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
  toChartPointsFromExecutions: () => [],
}))
// Captured so the wiring test can assert the detail view actually forwards
// the cancel + pagination handlers it receives — it used to accept and discard
// `onCancelPluginExecution` / `isPluginExecutionActive`.
const historyProps: Record<string, unknown>[] = []
jest.mock("./task-execution-history", () => ({
  __esModule: true,
  TaskExecutionHistory: (props: Record<string, unknown>) => {
    historyProps.push(props)
    return <div data-testid="task-execution-history-stub" />
  },
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

  it("offers Promote to system for a promotable trigger and confirms before promoting", () => {
    const cbs = { ...callbacks(), onPromote: jest.fn(), onUnpromote: jest.fn() }
    render(<TaskDetailView task={buildTask()} executions={[]} {...cbs} />)
    expect(screen.queryByTestId("task-promoted-badge")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("promote-task"))
    expect(cbs.onPromote).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("promote-confirm-accept"))
    expect(cbs.onPromote).toHaveBeenCalledWith("t1")
    expect(screen.queryByTestId("unpromote-task")).not.toBeInTheDocument()
  })

  it("shows the promoted badge and the un-promote entry for a promoted task", () => {
    const cbs = { ...callbacks(), onPromote: jest.fn(), onUnpromote: jest.fn() }
    render(
      <TaskDetailView
        task={buildTask({
          promotion: {
            systemTaskId: "sys-1",
            token: "t",
            promotedAt: new Date(),
            backend: "launchd",
          },
        })}
        executions={[]}
        {...cbs}
      />
    )
    expect(screen.getByTestId("task-promoted-badge")).toHaveTextContent("promote.badgeWithBackend")
    expect(screen.queryByTestId("promote-task")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("unpromote-task"))
    expect(cbs.onUnpromote).toHaveBeenCalledWith("t1")
  })

  it("hides promotion for event triggers and disables it when unavailable", () => {
    const cbs = { ...callbacks(), onPromote: jest.fn() }
    const { rerender } = render(
      <TaskDetailView
        task={buildTask({ trigger: { type: "event", eventType: "x" } })}
        executions={[]}
        {...cbs}
      />
    )
    expect(screen.queryByTestId("promote-task")).not.toBeInTheDocument()
    rerender(
      <TaskDetailView
        task={buildTask()}
        executions={[]}
        {...cbs}
        promotionAvailable={false}
        promotionUnavailableReason="nope"
      />
    )
    expect(screen.getByTestId("promote-task")).toHaveAttribute("title", "nope")
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

  it("shows the deprecated banner only for deprecated task types", () => {
    const cbs = callbacks()
    const { rerender } = render(
      <TaskDetailView task={buildTask({ type: "sync" })} executions={[]} {...cbs} />
    )
    expect(screen.getByTestId("task-deprecated-banner")).toBeInTheDocument()
    rerender(<TaskDetailView task={buildTask({ type: "chat" })} executions={[]} {...cbs} />)
    expect(screen.queryByTestId("task-deprecated-banner")).not.toBeInTheDocument()
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

describe("TaskDetailView · execution-list wiring", () => {
  beforeEach(() => {
    historyProps.length = 0
  })

  it("forwards plugin-run cancel and store pagination to the execution list", () => {
    const onCancelPluginExecution = jest.fn(() => true)
    const isPluginExecutionActive = jest.fn(() => true)
    const onLoadMoreExecutions = jest.fn()

    render(
      <TaskDetailView
        task={buildTask()}
        executions={[]}
        {...callbacks()}
        onCancelPluginExecution={onCancelPluginExecution}
        isPluginExecutionActive={isPluginExecutionActive}
        hasMoreExecutions
        onLoadMoreExecutions={onLoadMoreExecutions}
      />
    )

    const props = historyProps.at(-1)!
    expect(props.hasMoreOnServer).toBe(true)
    expect(props.onLoadMore).toBe(onLoadMoreExecutions)
    expect(props.canCancelExecution).toBe(isPluginExecutionActive)
    ;(props.onCancelExecution as (id: string) => void)("exec-1")
    expect(onCancelPluginExecution).toHaveBeenCalledWith("exec-1")
  })

  it("offers no cancel handler when the page supplies none", () => {
    render(<TaskDetailView task={buildTask()} executions={[]} {...callbacks()} />)
    expect(historyProps.at(-1)!.onCancelExecution).toBeUndefined()
  })
})

describe("TaskDetailView · duplicate", () => {
  it("offers Duplicate and passes the task id through", () => {
    const onClone = jest.fn()
    render(<TaskDetailView task={buildTask()} executions={[]} {...callbacks()} onClone={onClone} />)
    fireEvent.click(screen.getByTestId("clone-task"))
    expect(onClone).toHaveBeenCalledWith("t1")
  })

  it("omits the entry when the page supplies no handler", () => {
    render(<TaskDetailView task={buildTask()} executions={[]} {...callbacks()} />)
    expect(screen.queryByTestId("clone-task")).not.toBeInTheDocument()
  })
})
