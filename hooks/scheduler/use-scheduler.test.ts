/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

interface FakeStore {
  tasks: unknown[]
  executions: unknown[]
  statistics: unknown
  selectedTaskId: string | null
  selectedTask: unknown
  activeTasks: unknown[]
  pausedTasks: unknown[]
  upcomingTasks: unknown[]
  recentExecutions: unknown[]
  schedulerStatus: string
  filter: string
  isLoading: boolean
  error: string | null
  isInitialized: boolean
  hasMoreExecutions: boolean
  autoRefreshInterval: number
  initialize: jest.Mock
  refreshAll: jest.Mock
  createTask: jest.Mock
  updateTask: jest.Mock
  deleteTask: jest.Mock
  pauseTask: jest.Mock
  resumeTask: jest.Mock
  runTaskNow: jest.Mock
  selectTask: jest.Mock
  setFilter: jest.Mock
  clearFilter: jest.Mock
  clearError: jest.Mock
  loadMoreExecutions: jest.Mock
  loadRecentExecutions: jest.Mock
  loadUpcomingTasks: jest.Mock
  cleanupOldExecutions: jest.Mock
  cancelPluginExecution: jest.Mock
  getActivePluginCount: jest.Mock
  isPluginExecutionActive: jest.Mock
  exportTasks: jest.Mock
  importTasks: jest.Mock
  cloneTask: jest.Mock
  bulkPause: jest.Mock
  bulkResume: jest.Mock
  bulkDelete: jest.Mock
}

let storeRef: FakeStore = makeStore()

function makeStore(): FakeStore {
  return {
    tasks: [],
    executions: [],
    statistics: null,
    selectedTaskId: null,
    selectedTask: null,
    activeTasks: [],
    pausedTasks: [],
    upcomingTasks: [],
    recentExecutions: [],
    schedulerStatus: "stopped",
    filter: "all",
    isLoading: false,
    error: null,
    isInitialized: false,
    hasMoreExecutions: false,
    autoRefreshInterval: 0,
    initialize: jest.fn(async () => undefined),
    refreshAll: jest.fn(async () => undefined),
    createTask: jest.fn(),
    updateTask: jest.fn(),
    deleteTask: jest.fn(),
    pauseTask: jest.fn(),
    resumeTask: jest.fn(),
    runTaskNow: jest.fn(),
    selectTask: jest.fn(),
    setFilter: jest.fn(),
    clearFilter: jest.fn(),
    clearError: jest.fn(),
    loadMoreExecutions: jest.fn(),
    loadRecentExecutions: jest.fn(),
    loadUpcomingTasks: jest.fn(),
    cleanupOldExecutions: jest.fn(),
    cancelPluginExecution: jest.fn(),
    getActivePluginCount: jest.fn(),
    isPluginExecutionActive: jest.fn(),
    exportTasks: jest.fn(),
    importTasks: jest.fn(),
    cloneTask: jest.fn(),
    bulkPause: jest.fn(),
    bulkResume: jest.fn(),
    bulkDelete: jest.fn(),
  }
}

jest.mock("@/stores/scheduler", () => ({
  useSchedulerStore: <T>(selector?: (s: FakeStore) => T): T | FakeStore =>
    selector ? selector(storeRef) : storeRef,
  selectTasks: (s: FakeStore) => s.tasks,
  selectExecutions: (s: FakeStore) => s.executions,
  selectStatistics: (s: FakeStore) => s.statistics,
  selectSelectedTaskId: (s: FakeStore) => s.selectedTaskId,
  selectSelectedTask: (s: FakeStore) => s.selectedTask,
  selectActiveTasks: (s: FakeStore) => s.activeTasks,
  selectPausedTasks: (s: FakeStore) => s.pausedTasks,
  selectUpcomingTasks: (s: FakeStore) => s.upcomingTasks,
  selectRecentExecutions: (s: FakeStore) => s.recentExecutions,
  selectSchedulerStatus: (s: FakeStore) => s.schedulerStatus,
  selectFilter: (s: FakeStore) => s.filter,
  selectIsLoading: (s: FakeStore) => s.isLoading,
  selectError: (s: FakeStore) => s.error,
  selectIsInitialized: (s: FakeStore) => s.isInitialized,
}))

import { useScheduler } from "./use-scheduler"

beforeEach(() => {
  storeRef = makeStore()
  jest.useRealTimers()
})

describe("useScheduler", () => {
  it("calls initialize on first mount when not initialized", () => {
    renderHook(() => useScheduler())
    expect(storeRef.initialize).toHaveBeenCalledTimes(1)
  })

  it("does not initialize when already initialized", () => {
    storeRef.isInitialized = true
    renderHook(() => useScheduler())
    expect(storeRef.initialize).not.toHaveBeenCalled()
  })

  it("exposes store actions verbatim", () => {
    storeRef.isInitialized = true
    const { result } = renderHook(() => useScheduler())
    expect(result.current.createTask).toBe(storeRef.createTask)
    expect(result.current.updateTask).toBe(storeRef.updateTask)
    expect(result.current.deleteTask).toBe(storeRef.deleteTask)
    expect(result.current.pauseTask).toBe(storeRef.pauseTask)
    expect(result.current.resumeTask).toBe(storeRef.resumeTask)
    expect(result.current.runTaskNow).toBe(storeRef.runTaskNow)
    expect(result.current.selectTask).toBe(storeRef.selectTask)
    expect(result.current.refresh).toBe(storeRef.refreshAll)
    expect(result.current.clearError).toBe(storeRef.clearError)
    expect(result.current.exportTasks).toBe(storeRef.exportTasks)
    expect(result.current.importTasks).toBe(storeRef.importTasks)
    expect(result.current.cloneTask).toBe(storeRef.cloneTask)
    expect(result.current.bulkPause).toBe(storeRef.bulkPause)
    expect(result.current.bulkResume).toBe(storeRef.bulkResume)
    expect(result.current.bulkDelete).toBe(storeRef.bulkDelete)
  })

  it("BroadcastChannel: debounced execution-update triggers refreshAll", async () => {
    storeRef.isInitialized = true
    const channels: Array<{
      onmessage?: (e: { data: { type: string } }) => void
      close: jest.Mock
    }> = []
    class FakeBC {
      onmessage?: (e: { data: { type: string } }) => void
      close = jest.fn()
      constructor() {
        channels.push(
          this as unknown as {
            onmessage?: (e: { data: { type: string } }) => void
            close: jest.Mock
          }
        )
      }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      writable: true,
      value: FakeBC,
    })
    jest.useFakeTimers()
    renderHook(() => useScheduler())
    expect(channels.length).toBe(1)
    channels[0].onmessage?.({ data: { type: "execution-update" } })
    channels[0].onmessage?.({ data: { type: "execution-update" } })
    // Only the trailing call after the debounce should fire.
    await act(async () => {
      jest.advanceTimersByTime(300)
    })
    expect(storeRef.refreshAll).toHaveBeenCalledTimes(1)
  })

  it("BroadcastChannel: ignores unknown event types", async () => {
    storeRef.isInitialized = true
    const channels: Array<{
      onmessage?: (e: { data: { type: string } }) => void
      close: jest.Mock
    }> = []
    class FakeBC {
      onmessage?: (e: { data: { type: string } }) => void
      close = jest.fn()
      constructor() {
        channels.push(
          this as unknown as {
            onmessage?: (e: { data: { type: string } }) => void
            close: jest.Mock
          }
        )
      }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      writable: true,
      value: FakeBC,
    })
    jest.useFakeTimers()
    renderHook(() => useScheduler())
    channels[0].onmessage?.({ data: { type: "noise" } })
    await act(async () => {
      jest.advanceTimersByTime(500)
    })
    expect(storeRef.refreshAll).not.toHaveBeenCalled()
  })

  it("BroadcastChannel: missing API doesn't throw", () => {
    storeRef.isInitialized = true
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      writable: true,
      value: undefined,
    })
    expect(() => renderHook(() => useScheduler())).not.toThrow()
  })

  it("polling starts when autoRefreshInterval > 0 and tab visible", async () => {
    storeRef.isInitialized = true
    storeRef.autoRefreshInterval = 1
    Object.defineProperty(document, "hidden", {
      configurable: true,
      writable: true,
      value: false,
    })
    jest.useFakeTimers()
    renderHook(() => useScheduler())
    await act(async () => {
      jest.advanceTimersByTime(1500)
    })
    expect(storeRef.refreshAll).toHaveBeenCalled()
  })

  it("polling stops when document becomes hidden and resumes on visible", async () => {
    storeRef.isInitialized = true
    storeRef.autoRefreshInterval = 1
    Object.defineProperty(document, "hidden", {
      configurable: true,
      writable: true,
      value: false,
    })
    jest.useFakeTimers()
    renderHook(() => useScheduler())
    storeRef.refreshAll.mockClear()
    Object.defineProperty(document, "hidden", { value: true })
    document.dispatchEvent(new Event("visibilitychange"))
    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    expect(storeRef.refreshAll).not.toHaveBeenCalled()
    Object.defineProperty(document, "hidden", { value: false })
    document.dispatchEvent(new Event("visibilitychange"))
    expect(storeRef.refreshAll).toHaveBeenCalled()
  })

  it("polling skipped when autoRefreshInterval is zero", () => {
    storeRef.isInitialized = true
    storeRef.autoRefreshInterval = 0
    jest.useFakeTimers()
    renderHook(() => useScheduler())
    jest.advanceTimersByTime(5000)
    expect(storeRef.refreshAll).not.toHaveBeenCalled()
  })
})
