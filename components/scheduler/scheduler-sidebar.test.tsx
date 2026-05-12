/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub the Sidebar primitives so we don't need a Provider / matchMedia.
jest.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
}))

jest.mock("./task-sidebar-item", () => ({
  __esModule: true,
  TaskSidebarItem: ({
    task,
    onClick,
  }: {
    task: { id: string; name: string }
    onClick: (id: string) => void
  }) => (
    <button data-testid={`task-${task.id}`} onClick={() => onClick(task.id)}>
      {task.name}
    </button>
  ),
}))

jest.mock("./unified-task-sidebar-item", () => ({
  __esModule: true,
  UnifiedTaskSidebarItem: ({
    item,
    onClick,
  }: {
    item: { unifiedId: string; kind: string; sourceId: string; displayName: string }
    onClick: (i: unknown) => void
  }) => (
    <button data-testid={`unified-${item.unifiedId}`} onClick={() => onClick(item)}>
      {item.displayName}
    </button>
  ),
}))

jest.mock("./filter-chips", () => ({
  __esModule: true,
  FilterChips: ({
    filters,
    onFilterChange,
  }: {
    filters: Array<{ key: string; label: string }>
    onFilterChange: (k: string) => void
  }) => (
    <div>
      {filters.map((f) => (
        <button
          key={f.key}
          data-testid={`status-filter-${f.key}`}
          onClick={() => onFilterChange(f.key)}
        >
          {f.label}
        </button>
      ))}
    </div>
  ),
}))

jest.mock("./kind-filter-chips", () => ({
  __esModule: true,
  KindFilterChips: ({
    onToggle,
    onClear,
  }: {
    selected: Set<string>
    countsByKind: Record<string, number>
    onToggle: (k: string) => void
    onClear: () => void
  }) => (
    <div>
      <button data-testid="kind-toggle-workflow" onClick={() => onToggle("workflow")}>
        toggle-workflow
      </button>
      <button data-testid="kind-clear" onClick={onClear}>
        clear
      </button>
    </div>
  ),
}))

jest.mock("./empty-states", () => ({
  __esModule: true,
  TaskListEmptyState: ({
    onCreate,
    onClearFilters,
    variant,
  }: {
    onCreate?: () => void
    onClearFilters?: () => void
    variant?: string
  }) => (
    <div data-testid={`empty-state-${variant ?? "default"}`}>
      {onCreate && (
        <button onClick={onCreate} data-testid="empty-create">
          create
        </button>
      )}
      {onClearFilters && (
        <button onClick={onClearFilters} data-testid="empty-clear">
          clear
        </button>
      )}
    </div>
  ),
}))

import { SchedulerSidebar } from "./scheduler-sidebar"
import type { ScheduledTask, TaskStatistics } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function buildTask(id: string, status: ScheduledTask["status"] = "active"): ScheduledTask {
  return {
    id,
    name: `Task ${id}`,
    status,
    type: "custom",
    description: "",
    trigger: { type: "cron", cronExpression: "* * * * *" },
    payload: {},
    config: {},
    notification: { enabled: false },
    tags: [],
  } as unknown as ScheduledTask
}

function buildUnified(kind: UnifiedScheduledItem["kind"], unifiedId: string): UnifiedScheduledItem {
  return {
    unifiedId,
    kind,
    sourceId: unifiedId.split(":")[1] ?? unifiedId,
    displayName: `Display ${unifiedId}`,
  } as unknown as UnifiedScheduledItem
}

const baseStats: TaskStatistics = {
  totalTasks: 5,
  activeTasks: 3,
  pausedTasks: 1,
  totalExecutions: 100,
  successfulExecutions: 90,
  failedExecutions: 10,
} as unknown as TaskStatistics

function setup(overrides: Partial<React.ComponentProps<typeof SchedulerSidebar>> = {}) {
  const props: React.ComponentProps<typeof SchedulerSidebar> = {
    tasks: [buildTask("t1"), buildTask("t2", "paused")],
    systemTasks: [],
    selectedTaskId: null,
    schedulerStatus: "running",
    statistics: baseStats,
    activeCount: 3,
    pausedCount: 1,
    searchQuery: "",
    onSearchChange: jest.fn(),
    activeFilter: "all",
    onFilterChange: jest.fn(),
    onSelectTask: jest.fn(),
    onRunNow: jest.fn(),
    onPause: jest.fn(),
    onResume: jest.fn(),
    onDelete: jest.fn(),
    ...overrides,
  }
  return { props, ...render(<SchedulerSidebar {...props} />) }
}

describe("SchedulerSidebar", () => {
  it("renders legacy app tasks when unifiedItems is undefined", () => {
    setup()
    expect(screen.getByTestId("task-t1")).toBeInTheDocument()
    expect(screen.getByTestId("task-t2")).toBeInTheDocument()
  })

  it("calls onSearchChange when typing in the search input", () => {
    const onSearchChange = jest.fn()
    setup({ onSearchChange })
    fireEvent.change(screen.getByPlaceholderText("searchTasks"), { target: { value: "abc" } })
    expect(onSearchChange).toHaveBeenCalledWith("abc")
  })

  it("clears the search query via the X button", () => {
    const onSearchChange = jest.fn()
    setup({ searchQuery: "abc", onSearchChange })
    fireEvent.click(screen.getByLabelText("clearSearch"))
    expect(onSearchChange).toHaveBeenCalledWith("")
  })

  it("dispatches onFilterChange when a status chip is clicked", () => {
    const onFilterChange = jest.fn()
    setup({ onFilterChange })
    fireEvent.click(screen.getByTestId("status-filter-active"))
    expect(onFilterChange).toHaveBeenCalledWith("active")
  })

  it("dispatches onSelectTask when an app task is clicked", () => {
    const onSelectTask = jest.fn()
    setup({ onSelectTask })
    fireEvent.click(screen.getByTestId("task-t1"))
    expect(onSelectTask).toHaveBeenCalledWith("t1")
  })

  it("renders the status dot with the right class for each scheduler status", () => {
    const { rerender } = setup({ schedulerStatus: "running" })
    expect(screen.getByTestId("scheduler-status-dot").className).toMatch(/bg-green-500/)
    rerender(
      <SchedulerSidebar
        tasks={[]}
        systemTasks={[]}
        selectedTaskId={null}
        schedulerStatus="stopped"
        statistics={baseStats}
        activeCount={0}
        pausedCount={0}
        searchQuery=""
        onSearchChange={jest.fn()}
        activeFilter="all"
        onFilterChange={jest.fn()}
        onSelectTask={jest.fn()}
        onRunNow={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    expect(screen.getByTestId("scheduler-status-dot").className).toMatch(/bg-red-500/)
    rerender(
      <SchedulerSidebar
        tasks={[]}
        systemTasks={[]}
        selectedTaskId={null}
        schedulerStatus="idle"
        statistics={baseStats}
        activeCount={0}
        pausedCount={0}
        searchQuery=""
        onSearchChange={jest.fn()}
        activeFilter="all"
        onFilterChange={jest.fn()}
        onSelectTask={jest.fn()}
        onRunNow={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    expect(screen.getByTestId("scheduler-status-dot").className).toMatch(/bg-gray-400/)
  })

  it("renders the unified empty state when there are no tasks at all", () => {
    setup({
      tasks: [],
      systemTasks: [],
      unifiedItems: [],
      countsByKind: { app: 0, workflow: 0, backup: 0, plugin: 0, system: 0, connector: 0 },
    })
    expect(screen.getByTestId("empty-state-default")).toBeInTheDocument()
  })

  it("renders the filtered empty state when nothing matches the kind filter", () => {
    setup({
      tasks: [],
      systemTasks: [],
      unifiedItems: [buildUnified("app", "app:1")],
      countsByKind: { app: 1, workflow: 0, backup: 0, plugin: 0, system: 0, connector: 0 },
    })
    fireEvent.click(screen.getByTestId("kind-toggle-workflow"))
    expect(screen.getByTestId("empty-state-filtered")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("empty-clear"))
  })

  it("renders unified items grouped by kind", () => {
    setup({
      tasks: [],
      systemTasks: [],
      unifiedItems: [
        buildUnified("app", "app:1"),
        buildUnified("workflow", "workflow:2"),
        buildUnified("system", "system:3"),
      ],
      countsByKind: { app: 1, workflow: 1, backup: 0, plugin: 0, system: 1, connector: 0 },
    })
    expect(screen.getByTestId("unified-app:1")).toBeInTheDocument()
    expect(screen.getByTestId("unified-workflow:2")).toBeInTheDocument()
    expect(screen.getByTestId("unified-system:3")).toBeInTheDocument()
  })

  it("routes unified clicks to onSelectTask / onSelectSystemTask / onSelectUnifiedItem", () => {
    const onSelectTask = jest.fn()
    const onSelectSystemTask = jest.fn()
    const onSelectUnifiedItem = jest.fn()
    setup({
      tasks: [],
      systemTasks: [],
      unifiedItems: [
        buildUnified("app", "app:1"),
        buildUnified("system", "system:2"),
        buildUnified("workflow", "workflow:3"),
      ],
      countsByKind: { app: 1, workflow: 1, backup: 0, plugin: 0, system: 1, connector: 0 },
      onSelectTask,
      onSelectSystemTask,
      onSelectUnifiedItem,
    })
    fireEvent.click(screen.getByTestId("unified-app:1"))
    expect(onSelectTask).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("unified-system:2"))
    expect(onSelectSystemTask).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("unified-workflow:3"))
    expect(onSelectUnifiedItem).toHaveBeenCalled()
  })

  it("renders the footer success rate", () => {
    setup()
    expect(screen.getByText("90%")).toBeInTheDocument()
  })

  it("renders 0% success rate when no executions exist", () => {
    setup({
      statistics: {
        ...baseStats,
        totalExecutions: 0,
        successfulExecutions: 0,
      } as unknown as TaskStatistics,
    })
    expect(screen.getByText("0%")).toBeInTheDocument()
  })

  it("handles null statistics in the footer", () => {
    setup({ statistics: null })
    expect(screen.getByText("0%")).toBeInTheDocument()
  })
})
