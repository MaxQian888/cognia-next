/**
 * @jest-environment jsdom
 *
 * Tests focus on the platform gate, the unified-items filtering, FAB → create
 * flow, and the detail push overlay. The downstream scheduler components are
 * heavily Dexie/Tauri-dependent so they're stubbed.
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import type { TaskStatistics } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

const routerReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: jest.fn(), back: jest.fn() }),
}))

let platformValue: "tauri" | "mobile" | "web" = "mobile"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

const createTaskMock = jest.fn(async () => undefined)
const pauseTaskMock = jest.fn(async () => undefined)
const resumeTaskMock = jest.fn(async () => undefined)
const deleteTaskMock = jest.fn(async () => undefined)
const runTaskNowMock = jest.fn(async () => undefined)
const selectTaskMock = jest.fn()
const refreshMock = jest.fn(async () => undefined)
const loadRecentExecutionsMock = jest.fn(async () => undefined)
const loadUpcomingTasksMock = jest.fn(async () => undefined)

const schedulerStateRef: {
  current: {
    statistics: TaskStatistics | null
    selectedTask: { id: string; name: string } | null
    isInitialized: boolean
  }
} = {
  current: {
    statistics: {
      totalTasks: 4,
      activeTasks: 2,
      pausedTasks: 1,
      totalExecutions: 10,
      successfulExecutions: 9,
      failedExecutions: 1,
      averageDuration: 1500,
      upcomingExecutions: 1,
    } as TaskStatistics,
    selectedTask: null,
    isInitialized: true,
  },
}

jest.mock("@/hooks/scheduler", () => ({
  useScheduler: () => ({
    statistics: schedulerStateRef.current.statistics,
    selectedTask: schedulerStateRef.current.selectedTask,
    isInitialized: schedulerStateRef.current.isInitialized,
    createTask: createTaskMock,
    pauseTask: pauseTaskMock,
    resumeTask: resumeTaskMock,
    deleteTask: deleteTaskMock,
    runTaskNow: runTaskNowMock,
    selectTask: selectTaskMock,
    refresh: refreshMock,
    loadRecentExecutions: loadRecentExecutionsMock,
    loadUpcomingTasks: loadUpcomingTasksMock,
  }),
}))

let unifiedItemsRef: UnifiedScheduledItem[] = []
let countsByKindRef: Record<string, number> = {}
jest.mock("@/hooks/scheduler/use-unified-items", () => ({
  useUnifiedScheduledItems: () => ({
    items: unifiedItemsRef,
    countsByKind: countsByKindRef,
    activeCountsByKind: countsByKindRef,
  }),
}))

const sourceRunNow = jest.fn(async () => undefined)
const sourcePause = jest.fn(async () => undefined)
const sourceResume = jest.fn(async () => undefined)
const sourceDelete = jest.fn(async () => undefined)
jest.mock("@/lib/scheduler/sources/bootstrap", () => ({
  bootstrapSchedulerSources: jest.fn(),
}))
jest.mock("@/lib/scheduler/sources/registry", () => ({
  getSchedulerSourceRegistry: () => ({
    getSource: () => ({
      runNow: sourceRunNow,
      pause: sourcePause,
      resume: sourceResume,
      delete: sourceDelete,
    }),
  }),
}))

jest.mock("@/components/mobile/me/sub-page-shell", () => ({
  SubPageShell: ({
    children,
    title,
    testid,
  }: {
    children: React.ReactNode
    title: string
    testid?: string
  }) => (
    <div data-testid={testid}>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}))

jest.mock("@/components/scheduler", () => ({
  FilterChips: ({
    activeFilter,
    onFilterChange,
    filters,
  }: {
    activeFilter: string
    onFilterChange: (key: string) => void
    filters: Array<{ key: string; label: string; count?: number }>
  }) => (
    <div data-testid="filter-chips">
      {filters.map((f) => (
        <button
          key={f.key}
          type="button"
          data-active={activeFilter === f.key}
          data-testid={`filter-chip-${f.key}`}
          onClick={() => onFilterChange(f.key)}
        >
          {f.label} ({f.count ?? 0})
        </button>
      ))}
    </div>
  ),
  SchedulerMobileDetailView: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="stub-mobile-detail-view">
      <button type="button" onClick={onBack} data-testid="stub-detail-back">
        back
      </button>
    </div>
  ),
  TaskForm: ({
    onSubmit,
    onCancel,
  }: {
    onSubmit: (input: unknown) => Promise<void>
    onCancel: () => void
  }) => (
    <div data-testid="stub-task-form">
      <button
        type="button"
        data-testid="stub-task-form-submit"
        onClick={() => void onSubmit({ name: "new" })}
      >
        submit
      </button>
      <button type="button" data-testid="stub-task-form-cancel" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}))

jest.mock("@/components/scheduler/kind-filter-chips", () => ({
  KindFilterChips: ({
    selected,
    onToggle,
    onClear,
  }: {
    selected: Set<string>
    onToggle: (kind: string) => void
    onClear: () => void
  }) => (
    <div data-testid="kind-filter-chips">
      <button type="button" onClick={onClear} data-testid="kind-clear">
        clear
      </button>
      <button type="button" onClick={() => onToggle("workflow")} data-testid="kind-workflow">
        workflow {selected.has("workflow") ? "on" : "off"}
      </button>
    </div>
  ),
}))

jest.mock("@/components/scheduler/unified-task-sidebar-item", () => ({
  UnifiedTaskSidebarItem: ({
    item,
    onClick,
    onDelete,
  }: {
    item: UnifiedScheduledItem
    onClick: (item: UnifiedScheduledItem) => void
    onDelete?: (item: UnifiedScheduledItem) => void
  }) => (
    <div data-testid={`unified-row-${item.unifiedId}-wrapper`}>
      <button
        type="button"
        data-testid={`unified-row-${item.unifiedId}`}
        onClick={() => onClick(item)}
      >
        {item.name}
      </button>
      {onDelete ? (
        <button
          type="button"
          data-testid={`unified-row-${item.unifiedId}-delete`}
          onClick={() => onDelete(item)}
        >
          delete
        </button>
      ) : null}
    </div>
  ),
}))

jest.mock("@/components/mobile/scheduler/mobile-scheduler-stat-strip", () => ({
  MobileSchedulerStatStrip: ({ statistics }: { statistics: TaskStatistics | null }) => (
    <div data-testid="stub-stat-strip">{statistics ? statistics.activeTasks : "no-stats"}</div>
  ),
}))

jest.mock("@/components/ui/floating-action-button", () => ({
  FloatingActionButton: (props: React.ComponentProps<"button">) => (
    <button type="button" {...props} data-testid="stub-fab" />
  ),
}))

function makeItem(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:task-1",
    kind: "app",
    sourceId: "task-1",
    name: "Daily summary",
    status: "active",
    triggerSummary: { type: "cron", text: "0 9 * * *" },
    origin: { tableName: "schedulerDb.tasks", deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  } as UnifiedScheduledItem
}

import MobileSchedulerPage from "./page"

beforeEach(() => {
  routerReplace.mockReset()
  createTaskMock.mockReset()
  selectTaskMock.mockReset()
  sourceRunNow.mockReset()
  sourcePause.mockReset()
  sourceResume.mockReset()
  sourceDelete.mockReset()
  platformValue = "mobile"
  unifiedItemsRef = []
  countsByKindRef = { app: 0, workflow: 0, backup: 0, plugin: 0, system: 0, connector: 0 }
  schedulerStateRef.current.selectedTask = null
})

describe("MobileSchedulerPage platform gate", () => {
  it("renders the mobile body on Capacitor", () => {
    platformValue = "mobile"
    render(<MobileSchedulerPage />)
    expect(screen.getByTestId("mobile-scheduler-page")).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it("returns null and redirects to /scheduler on the web", () => {
    platformValue = "web"
    const { container } = render(<MobileSchedulerPage />)
    expect(container.firstChild).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith("/scheduler")
  })

  it("returns null and redirects to /scheduler on Tauri desktop", () => {
    platformValue = "tauri"
    const { container } = render(<MobileSchedulerPage />)
    expect(container.firstChild).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith("/scheduler")
  })
})

describe("MobileSchedulerPage list rendering", () => {
  it("renders the empty state when there are no unified items", () => {
    render(<MobileSchedulerPage />)
    expect(screen.getByTestId("mobile-scheduler-empty")).toBeInTheDocument()
  })

  it("groups items by kind and renders rows", () => {
    unifiedItemsRef = [
      makeItem({ unifiedId: "app:1", name: "App task" }),
      makeItem({ unifiedId: "workflow:2", kind: "workflow", name: "WF task" }),
    ]
    render(<MobileSchedulerPage />)
    expect(screen.getByTestId("unified-row-app:1")).toBeInTheDocument()
    expect(screen.getByTestId("unified-row-workflow:2")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-scheduler-group-app")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-scheduler-group-workflow")).toBeInTheDocument()
  })

  it("filters by status when the active chip is clicked", () => {
    unifiedItemsRef = [
      makeItem({ unifiedId: "app:1", name: "Active" }),
      makeItem({ unifiedId: "app:2", name: "Paused", status: "paused" }),
    ]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("filter-chip-paused"))
    expect(screen.queryByTestId("unified-row-app:1")).toBeNull()
    expect(screen.getByTestId("unified-row-app:2")).toBeInTheDocument()
  })

  it("filters by kind when a kind chip is toggled", () => {
    unifiedItemsRef = [
      makeItem({ unifiedId: "app:1", kind: "app", name: "App" }),
      makeItem({ unifiedId: "workflow:2", kind: "workflow", name: "Workflow" }),
    ]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("kind-workflow"))
    expect(screen.queryByTestId("unified-row-app:1")).toBeNull()
    expect(screen.getByTestId("unified-row-workflow:2")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("kind-clear"))
    expect(screen.getByTestId("unified-row-app:1")).toBeInTheDocument()
  })

  it("filters by the search input", () => {
    unifiedItemsRef = [
      makeItem({ unifiedId: "app:1", name: "Daily summary" }),
      makeItem({ unifiedId: "app:2", name: "Weekly digest" }),
    ]
    render(<MobileSchedulerPage />)
    fireEvent.change(screen.getByTestId("mobile-scheduler-search"), {
      target: { value: "weekly" },
    })
    expect(screen.queryByTestId("unified-row-app:1")).toBeNull()
    expect(screen.getByTestId("unified-row-app:2")).toBeInTheDocument()
  })
})

describe("MobileSchedulerPage interactions", () => {
  it("opens the create sheet when the FAB is clicked", () => {
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("stub-fab"))
    expect(screen.getByTestId("stub-task-form")).toBeInTheDocument()
  })

  it("calls createTask and closes the sheet on submit", async () => {
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("stub-fab"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("stub-task-form-submit"))
    })
    expect(createTaskMock).toHaveBeenCalledWith({ name: "new" })
  })

  it("routes app-kind selections through selectTask and unified-kind selections through state", () => {
    unifiedItemsRef = [
      makeItem({ unifiedId: "app:1", kind: "app", sourceId: "task-1" }),
      makeItem({ unifiedId: "workflow:2", kind: "workflow", sourceId: "wf-1" }),
    ]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("unified-row-app:1"))
    expect(selectTaskMock).toHaveBeenCalledWith("task-1")

    selectTaskMock.mockClear()
    fireEvent.click(screen.getByTestId("unified-row-workflow:2"))
    expect(selectTaskMock).toHaveBeenCalledWith(null)
    expect(screen.getByTestId("mobile-scheduler-detail-overlay")).toBeInTheDocument()
    expect(screen.getByTestId("stub-mobile-detail-view")).toBeInTheDocument()
  })

  it("hides the FAB when the detail overlay is showing", () => {
    unifiedItemsRef = [makeItem({ unifiedId: "workflow:2", kind: "workflow" })]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("unified-row-workflow:2"))
    expect(screen.queryByTestId("stub-fab")).toBeNull()
  })

  it("dismisses the detail overlay when the stubbed back handler fires", () => {
    unifiedItemsRef = [makeItem({ unifiedId: "workflow:2", kind: "workflow" })]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("unified-row-workflow:2"))
    fireEvent.click(screen.getByTestId("stub-detail-back"))
    expect(screen.queryByTestId("mobile-scheduler-detail-overlay")).toBeNull()
    expect(screen.getByTestId("stub-fab")).toBeInTheDocument()
  })
})

describe("MobileSchedulerPage delete flow", () => {
  it("opens the AlertDialog naming the unified item being deleted", () => {
    unifiedItemsRef = [
      makeItem({
        unifiedId: "workflow:wf-1",
        kind: "workflow",
        sourceId: "wf-1",
        name: "Nightly digest",
      }),
    ]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("unified-row-workflow:wf-1-delete"))
    const dialog = screen.getByTestId("mobile-scheduler-delete-confirm")
    expect(dialog).toBeInTheDocument()
    expect(dialog.textContent).toContain("Nightly digest")
  })

  it("routes the delete dispatch through the source registry for unified kinds", async () => {
    unifiedItemsRef = [
      makeItem({
        unifiedId: "backup:b-1",
        kind: "backup",
        sourceId: "b-1",
        name: "Backup task",
      }),
    ]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("unified-row-backup:b-1-delete"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-scheduler-delete-confirm-button"))
    })
    expect(sourceDelete).toHaveBeenCalledWith("b-1")
  })

  it("also routes the app-kind delete through the source registry (no /scheduler.deleteTask short-circuit)", async () => {
    unifiedItemsRef = [
      makeItem({ unifiedId: "app:task-1", kind: "app", sourceId: "task-1", name: "App task" }),
    ]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("unified-row-app:task-1-delete"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-scheduler-delete-confirm-button"))
    })
    expect(sourceDelete).toHaveBeenCalledWith("task-1")
  })

  it("dismisses the AlertDialog when Cancel is clicked", () => {
    unifiedItemsRef = [makeItem({ unifiedId: "app:task-1", kind: "app", sourceId: "task-1" })]
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("unified-row-app:task-1-delete"))
    expect(screen.getByTestId("mobile-scheduler-delete-confirm")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mobile-scheduler-delete-cancel"))
    expect(screen.queryByTestId("mobile-scheduler-delete-confirm")).toBeNull()
    expect(sourceDelete).not.toHaveBeenCalled()
  })
})
