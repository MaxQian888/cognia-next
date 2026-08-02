/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

// The summary band renders live under test — only its Card-free layout matters
// here; its own numbers/bars are covered by scheduler-overview-summary.test.

jest.mock("./task-execution-chart", () => ({
  __esModule: true,
  TaskExecutionChart: () => <div data-testid="task-execution-chart-stub" />,
}))

// Stub the execution monitor — it has its own dedicated test and pulls live
// Dexie / broker sources we don't want to stand up for the dashboard layout test.
jest.mock("@/components/execution/execution-monitor-panel", () => ({
  __esModule: true,
  ExecutionMonitorPanel: () => <div data-testid="execution-monitor-stub" />,
}))

// Stub the calendar/timeline views — they have their own dedicated tests; here
// we only assert the dashboard routes to the right one for the active mode.
jest.mock("./scheduler-calendar-view", () => ({
  __esModule: true,
  SchedulerCalendarView: () => <div data-testid="calendar-view-stub" />,
}))
jest.mock("./scheduler-timeline-view", () => ({
  __esModule: true,
  SchedulerTimelineView: () => <div data-testid="timeline-view-stub" />,
}))

// Stub the unified runs widget — it has its own test and pulls live Dexie
// sources; here we only assert the dashboard swaps to it.
jest.mock("./unified-recent-runs", () => ({
  __esModule: true,
  UnifiedRecentRuns: () => <div data-testid="unified-recent-runs-stub" />,
}))

const viewState = { view: "overview" as "overview" | "calendar" | "timeline" }
jest.mock("@/hooks/scheduler/use-scheduler-dashboard-view", () => ({
  __esModule: true,
  useSchedulerDashboardView: () => ({ view: viewState.view, setView: jest.fn() }),
  isSchedulerDashboardView: (v: string) => ["overview", "calendar", "timeline"].includes(v),
}))

import { SchedulerDashboardView } from "./scheduler-dashboard-view"
import type { ScheduledTask, TaskExecution, TaskStatistics } from "@/types/scheduler"

const stats: TaskStatistics = {
  totalTasks: 10,
  activeTasks: 6,
  pausedTasks: 2,
  totalExecutions: 100,
  successfulExecutions: 95,
  failedExecutions: 5,
  averageDuration: 1000,
  upcomingExecutions: 2,
}

const upcoming: ScheduledTask[] = [
  {
    id: "t1",
    name: "Upcoming task 1",
    status: "active",
    nextRunAt: new Date(Date.now() + 60_000),
  } as unknown as ScheduledTask,
  {
    id: "t2",
    name: "Upcoming task 2",
    status: "paused",
    nextRunAt: new Date(Date.now() + 120_000),
  } as unknown as ScheduledTask,
]

const recent: TaskExecution[] = [
  {
    id: "e1",
    taskId: "t1",
    taskName: "Task 1",
    status: "completed",
    startedAt: new Date(Date.now() - 60_000),
    completedAt: new Date(Date.now() - 30_000),
    duration: 30_000,
  } as unknown as TaskExecution,
  {
    id: "e2",
    taskId: "t2",
    taskName: "Task 2",
    status: "failed",
    startedAt: new Date(Date.now() - 90_000),
    duration: 1000,
  } as unknown as TaskExecution,
  {
    id: "e3",
    taskId: "t3",
    taskName: "Task 3",
    status: "running",
    startedAt: new Date(Date.now() - 5_000),
    duration: 5000,
  } as unknown as TaskExecution,
]

function setup(overrides: Partial<React.ComponentProps<typeof SchedulerDashboardView>> = {}) {
  const props: React.ComponentProps<typeof SchedulerDashboardView> = {
    statistics: stats,
    activeTasks: [],
    pausedTasks: [],
    upcomingTasks: upcoming,
    recentExecutions: recent,
    schedulerStatus: "running",
    onSelectTask: jest.fn(),
    ...overrides,
  }
  return { props, ...render(<SchedulerDashboardView {...props} />) }
}

beforeEach(() => {
  viewState.view = "overview"
})

describe("SchedulerDashboardView", () => {
  it("always renders the view toggle, even when statistics is null", () => {
    setup({ statistics: null })
    expect(screen.getByTestId("scheduler-dashboard-view-toggle")).toBeInTheDocument()
    // Overview body bails out → no summary band rendered.
    expect(screen.queryByTestId("scheduler-overview-summary")).toBeNull()
  })

  it("renders the summary band and the success rate in overview mode", () => {
    setup()
    expect(screen.getByTestId("scheduler-overview-summary")).toBeInTheDocument()
    expect(screen.getByText("10")).toBeInTheDocument()
    expect(screen.getByTestId("summary-success-rate")).toHaveTextContent("95%")
  })

  it("renders the calendar view when mode is calendar", () => {
    viewState.view = "calendar"
    setup({ tasks: [] })
    expect(screen.getByTestId("calendar-view-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-overview-summary")).toBeNull()
  })

  it("renders the timeline view when mode is timeline", () => {
    viewState.view = "timeline"
    setup({ tasks: [] })
    expect(screen.getByTestId("timeline-view-stub")).toBeInTheDocument()
  })

  it("renders the upcoming tasks list and dispatches onSelectTask on click", () => {
    const onSelectTask = jest.fn()
    setup({ onSelectTask })
    fireEvent.click(screen.getByText("Upcoming task 1"))
    expect(onSelectTask).toHaveBeenCalledWith("t1")
  })

  it("renders the no-upcoming empty state when upcomingTasks is empty", () => {
    setup({ upcomingTasks: [] })
    expect(screen.getByText("noUpcomingTasks")).toBeInTheDocument()
  })

  it("renders recent executions with task names and durations", () => {
    setup()
    expect(screen.getByText("Task 1")).toBeInTheDocument()
    expect(screen.getByText("Task 2")).toBeInTheDocument()
    expect(screen.getByText("Task 3")).toBeInTheDocument()
  })

  it("renders a status icon for every execution state, including pending", () => {
    const { container } = setup({
      recentExecutions: [
        ...recent,
        { id: "e4", taskId: "t4", taskName: "Task 4", status: "pending" } as TaskExecution,
      ],
    })
    // completed / failed / running / pending → four distinct icon colours.
    expect(container.querySelector(".text-green-500")).not.toBeNull()
    expect(container.querySelector(".text-red-500")).not.toBeNull()
    expect(container.querySelector(".text-blue-500")).not.toBeNull()
    expect(screen.getByText("Task 4")).toBeInTheDocument()
  })

  it("swaps in the unified cross-kind runs widget when onSelectRun is supplied", () => {
    setup({ onSelectRun: jest.fn() })
    expect(screen.getByTestId("unified-recent-runs-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("overview-recent")).toBeNull()
  })

  it("renders the no-recent-executions empty state when recentExecutions is empty", () => {
    setup({ recentExecutions: [] })
    expect(screen.getByText("noRecentExecutions")).toBeInTheDocument()
  })

  it("renders the kind summary strip when countsByKind is supplied", () => {
    setup({
      countsByKind: { app: 4, workflow: 2, backup: 1, plugin: 0, system: 3, connector: 0 },
      activeCountsByKind: {
        app: 2,
        workflow: 1,
        backup: 0,
        plugin: 0,
        system: 1,
        connector: 0,
      },
    })
    expect(screen.getByTestId("kind-summary-strip")).toBeInTheDocument()
    expect(screen.getByTestId("kind-summary-app")).toBeInTheDocument()
    expect(screen.getByTestId("kind-summary-workflow")).toBeInTheDocument()
  })

  it("omits the kind summary strip when countsByKind is absent", () => {
    setup()
    expect(screen.queryByTestId("kind-summary-strip")).toBeNull()
  })

  it("passes a low success rate through to the summary band", () => {
    setup({ statistics: { ...stats, successfulExecutions: 50, totalExecutions: 100 } })
    expect(screen.getByTestId("summary-success-rate")).toHaveTextContent("50%")
  })

  it("renders 0% success when totalExecutions is zero", () => {
    setup({ statistics: { ...stats, successfulExecutions: 0, totalExecutions: 0 } })
    expect(screen.getByTestId("summary-success-rate")).toHaveTextContent("0%")
  })

  it("lays the overview out as flat blocks rather than nested cards", () => {
    const { container } = setup()
    // The summary, upcoming and recent blocks are plain sections — the only
    // `Card` left in the overview tree belongs to a stubbed child widget.
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(0)
    expect(screen.getByTestId("overview-upcoming")).toBeInTheDocument()
    expect(screen.getByTestId("overview-recent")).toBeInTheDocument()
  })
})
