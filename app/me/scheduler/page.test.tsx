/**
 * `/me/scheduler` (ADR-0179 §6): the phone shell over the shared scheduler
 * components. The data hooks and the heavy children are stubbed; what is
 * pinned here is the wiring: the same store-backed filter and address-backed
 * selection as the desktop, the detail push with the full run set, the
 * confirmed delete for every kind, and the composer draft hand-off.
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

const routerReplace = jest.fn()
const routerPush = jest.fn()
let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: routerPush, back: jest.fn() }),
  usePathname: () => "/me/scheduler",
  useSearchParams: () => searchParams,
}))

let compactValue = true
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: () => compactValue }))

const createTaskMock = jest.fn(async () => ({ id: "new", name: "New" }))
const updateTaskMock = jest.fn(async () => undefined)
const pauseTaskMock = jest.fn(async () => undefined)
const resumeTaskMock = jest.fn(async () => undefined)
const deleteTaskMock = jest.fn(async () => true)
const runTaskNowMock = jest.fn(async () => undefined)
const selectTaskMock = jest.fn()
const refreshMock = jest.fn(async () => undefined)
const cancelExecutionMock = jest.fn(async () => ({ cancelled: true }))
const loadMoreExecutionsMock = jest.fn()

const executionsRef: { current: unknown[] } = { current: [] }
jest.mock("@/hooks/scheduler", () => ({
  useScheduler: () => ({
    tasks: [{ id: "t1", name: "Nightly", type: "chat", status: "active" }],
    executions: executionsRef.current,
    selectedTask: undefined,
    isInitialized: true,
    isLoading: false,
    createTask: createTaskMock,
    updateTask: updateTaskMock,
    deleteTask: deleteTaskMock,
    pauseTask: pauseTaskMock,
    resumeTask: resumeTaskMock,
    runTaskNow: runTaskNowMock,
    selectTask: selectTaskMock,
    refresh: refreshMock,
    cancelExecution: cancelExecutionMock,
    hasMoreExecutions: true,
    loadMoreExecutions: loadMoreExecutionsMock,
  }),
  useSystemScheduler: () => ({ tasks: [], pendingConfirmations: [] }),
}))

let unifiedItemsRef: UnifiedScheduledItem[] = []
jest.mock("@/hooks/scheduler/use-unified-items", () => ({
  useUnifiedScheduledItems: () => ({ items: unifiedItemsRef, errors: {} }),
}))
let recentRunsRef: UnifiedExecutionRun[] = []
jest.mock("@/hooks/scheduler/use-unified-recent-runs", () => ({
  useUnifiedRecentRuns: () => ({ runs: recentRunsRef, isLoading: false }),
  toUnifiedFromTaskExecution: (exec: { id: string }) => ({
    unifiedId: `app:${exec.id}`,
    kind: "app",
    itemUnifiedId: "app:t1",
    itemName: "Nightly",
    status: "succeeded",
    startedAt: 1,
    origin: { tableName: "t", nativeId: exec.id },
  }),
}))

const sourceDelete = jest.fn(async () => undefined)
const sourcePause = jest.fn(async () => undefined)
jest.mock("@/lib/scheduler/sources/bootstrap", () => ({ bootstrapSchedulerSources: jest.fn() }))
jest.mock("@/lib/scheduler/sources/registry", () => ({
  getSchedulerSourceRegistry: () => ({
    getSource: () => ({
      delete: sourceDelete,
      pause: sourcePause,
      resume: jest.fn(),
      runNow: jest.fn(),
    }),
  }),
}))
const draftRef: { current: { input: Record<string, unknown>; summary?: string } | null } = {
  current: null,
}
jest.mock("@/lib/scheduler/task-draft-handoff", () => ({
  consumeScheduledTaskDraft: () => {
    const handed = draftRef.current
    draftRef.current = null
    return handed
  },
}))

jest.mock("@/components/mobile/me/sub-page-shell", () => ({
  SubPageShell: ({ children, testid }: { children: React.ReactNode; testid?: string }) => (
    <div data-testid={testid}>{children}</div>
  ),
}))
jest.mock("@/components/scheduler/scheduler-host-popover", () => ({
  SchedulerHostPopover: () => <div data-testid="host-popover" />,
  SchedulerHostStatusBadge: () => null,
  SchedulerHostSummaryLine: () => <span data-testid="host-summary" />,
  useSchedulerHostSummary: () => ({
    target: "local",
    label: "this device",
    pairedAvailable: false,
    suspended: false,
    onlyWhileOpen: false,
    pairedLabel: "",
    setTarget: jest.fn(),
  }),
}))
jest.mock("@/components/scheduler/detail/item-detail", () => ({
  ItemDetail: ({
    item,
    runs,
    hasMoreRuns,
    actions,
  }: {
    item: { name: string }
    runs: unknown[]
    hasMoreRuns?: boolean
    actions: { onDelete: (i: unknown) => void; onPause: (i: unknown) => void }
  }) => (
    <div data-testid="item-detail" data-runs={runs.length} data-more={String(hasMoreRuns)}>
      {item.name}
      <button data-testid="detail-delete" onClick={() => actions.onDelete(item)} />
      <button data-testid="detail-pause" onClick={() => actions.onPause(item)} />
    </div>
  ),
}))
jest.mock("@/components/scheduler/run-detail-sheet", () => ({
  RunDetailSheet: ({ open, run }: { open: boolean; run: { unifiedId: string } | null }) =>
    open && run ? <div data-testid="run-sheet">{run.unifiedId}</div> : null,
}))
jest.mock("@/components/scheduler", () => ({
  FilterChips: () => <div data-testid="filter-chips" />,
  SchedulerSkeleton: () => <div data-testid="skeleton" />,
  TaskForm: ({
    onSubmit,
    initialValues,
  }: {
    onSubmit: (i: unknown) => void
    initialValues?: { name?: string }
  }) => (
    <button
      data-testid="task-form"
      data-name={initialValues?.name ?? ""}
      onClick={() => onSubmit({ name: "x" })}
    />
  ),
}))
jest.mock("@/components/scheduler/kind-filter-chips", () => ({
  KindFilterChips: () => <div data-testid="kind-chips" />,
}))
jest.mock("@/components/ui/sheet")
jest.mock("@/components/scheduler/delete-item-dialog", () => ({
  DeleteItemDialog: ({
    item,
    onConfirm,
  }: {
    item: { name: string } | null
    onConfirm: () => void
  }) =>
    item ? (
      <button data-testid="confirm-delete" onClick={onConfirm}>
        {item.name}
      </button>
    ) : null,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))

import MobileSchedulerPage from "./page"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"

function item(
  kind: UnifiedScheduledItem["kind"],
  sourceId: string,
  name: string
): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name,
    status: "active",
    triggerSummary: { type: "cron", cron: "* * * * *" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  compactValue = true
  searchParams = new URLSearchParams()
  unifiedItemsRef = [item("app", "t1", "Nightly"), item("workflow", "w1", "Deploy")]
  recentRunsRef = []
  executionsRef.current = []
  draftRef.current = null
  useSchedulerStore.getState().resetListFilter()
})

describe("MobileSchedulerPage", () => {
  it("bounces a wide layout to the desktop route", () => {
    compactValue = false
    render(<MobileSchedulerPage />)
    expect(routerReplace).toHaveBeenCalledWith("/scheduler")
  })

  it("keeps the open task and run when it bounces to the desktop route", () => {
    compactValue = false
    searchParams = new URLSearchParams("item=app%3At1&run=app%3Ar1")
    render(<MobileSchedulerPage />)
    expect(routerReplace).toHaveBeenCalledWith("/scheduler?item=app%3At1&run=app%3Ar1")
  })

  it("renders the stat strip, the attention block and one row per item", () => {
    render(<MobileSchedulerPage />)
    // Pinned: the shell section is a flex column and the strip must not be
    // the child that yields (it collapsed to one clipped row on a phone).
    expect(screen.getByTestId("mobile-scheduler-stats")).toHaveClass("shrink-0")
    expect(screen.getByTestId("mobile-scheduler-stat-active")).toHaveTextContent("2/2")
    // jsdom is a web host, so the chat task reads as unsupported: the block has a row.
    expect(screen.getByTestId("attention-block")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-list-row-app:t1")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-list-row-workflow:w1")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-scheduler-fab")).toBeInTheDocument()
  })

  it("writes a tap into the address and opens the detail from it with the full run set", () => {
    const first = render(<MobileSchedulerPage />)
    fireEvent.click(
      screen
        .getByTestId("scheduler-list-row-app:t1")
        .querySelector("button[aria-current], button:not([role='checkbox'])")!
    )
    expect(routerReplace).toHaveBeenCalledWith("/me/scheduler?item=app%3At1")
    first.unmount()

    executionsRef.current = [{ id: "e1" }, { id: "e2" }]
    searchParams = new URLSearchParams("item=app:t1")
    render(<MobileSchedulerPage />)
    const detail = screen.getByTestId("item-detail")
    expect(detail).toHaveTextContent("Nightly")
    expect(detail.dataset.runs).toBe("2")
    expect(detail.dataset.more).toBe("true")
    expect(selectTaskMock).toHaveBeenCalledWith("t1")
    expect(screen.queryByTestId("mobile-scheduler-fab")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mobile-scheduler-back"))
    expect(routerReplace).toHaveBeenLastCalledWith("/me/scheduler")
  })

  it("confirms a delete and routes it by kind", async () => {
    searchParams = new URLSearchParams("item=workflow:w1")
    render(<MobileSchedulerPage />)
    fireEvent.click(screen.getByTestId("detail-delete"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-delete"))
    })
    expect(sourceDelete).toHaveBeenCalledWith("w1")
    expect(deleteTaskMock).not.toHaveBeenCalled()
    expect(routerReplace).toHaveBeenLastCalledWith("/me/scheduler")
  })

  it("pauses an app row through the store and another kind through its source", async () => {
    searchParams = new URLSearchParams("item=app:t1")
    render(<MobileSchedulerPage />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("detail-pause"))
    })
    expect(pauseTaskMock).toHaveBeenCalledWith("t1")
    expect(sourcePause).not.toHaveBeenCalled()
  })

  it("opens the run sheet from the address", () => {
    recentRunsRef = [
      {
        unifiedId: "workflow:r1",
        kind: "workflow",
        itemUnifiedId: "workflow:w1",
        itemName: "Deploy",
        status: "succeeded",
        startedAt: 1,
        origin: { tableName: "t", nativeId: "r1" },
      },
    ]
    searchParams = new URLSearchParams("run=workflow:r1")
    render(<MobileSchedulerPage />)
    expect(screen.getByTestId("run-sheet")).toHaveTextContent("workflow:r1")
  })

  it("consumes a composer draft into the create sheet and lands on the created task", async () => {
    draftRef.current = { input: { name: "Remind me" }, summary: "Every morning" }
    render(<MobileSchedulerPage />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId("task-form").dataset.name).toBe("Remind me")
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-form"))
    })
    expect(createTaskMock).toHaveBeenCalled()
    expect(routerReplace).toHaveBeenLastCalledWith("/me/scheduler?item=app%3Anew")
  })

  it("filters through the shared store", () => {
    act(() => {
      useSchedulerStore.getState().setListFilter({ search: "deploy" })
    })
    render(<MobileSchedulerPage />)
    expect(screen.queryByTestId("scheduler-list-row-app:t1")).not.toBeInTheDocument()
    expect(screen.getByTestId("scheduler-list-row-workflow:w1")).toBeInTheDocument()
  })
})
