import { act, renderHook, waitFor } from "@testing-library/react"
import type { EvalProject } from "@cognia/eval-core"
import { useEvalExecution } from "./use-eval-execution"

let scope = { accountId: "acct_alpha", targetId: "desktop-one", routingGeneration: 1 }
let accountRevision = 1
let locked = false
const listeners = new Set<() => void>()
const unsubscribe = jest.fn()
let onStatus: (value: unknown) => void
const runtime = {
  recover: jest.fn(async () => [] as Array<{ experimentId: string; state: string }>),
  start: jest.fn(async () => "exp-1"),
  status: jest.fn(async (experimentId: string) => ({
    experimentId,
    state: "running",
    total: 1,
    completed: 0,
    spentCost: 0,
    reservedCost: 1,
    budgetCap: 2,
  })),
  report: jest.fn(async (id: string) => ({ experiment: { id } })),
  subscribe: jest.fn((_id: string, callback: typeof onStatus) => {
    onStatus = callback
    return unsubscribe
  }),
  getReviewService: jest.fn(async () => ({ vote: jest.fn() })),
  pause: jest.fn(async () => {}),
  resume: jest.fn(async () => {}),
  cancel: jest.fn(async () => {}),
  extendBudget: jest.fn(async () => {}),
  dispose: jest.fn(),
}
jest.mock("@/lib/ai/eval/execution-runtime", () => ({ getEvalExecutionRuntime: () => runtime }))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => scope,
  subscribeRuntimeTargetContext: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: Object.assign(
    (
      select: (state: {
        unlockedAccountId: string
        accountRevision: number
        locked: boolean
      }) => unknown
    ) => select({ unlockedAccountId: scope.accountId, accountRevision, locked }),
    {
      getState: () => ({ unlockedAccountId: scope.accountId, accountRevision, locked }),
    }
  ),
}))

beforeEach(() => {
  jest.clearAllMocks()
  accountRevision = 1
  locked = false
  scope = { accountId: "acct_alpha", targetId: "desktop-one", routingGeneration: 1 }
  runtime.recover.mockResolvedValue([])
  runtime.report.mockImplementation(async (id) => ({ experiment: { id } }))
})

it("sends commands to the service and releases only the UI subscription on unmount", async () => {
  const { result, unmount } = renderHook(() => useEvalExecution())
  await waitFor(() =>
    expect({
      available: result.current.available,
      error: result.current.error,
      scope: result.current.scopeKey,
    }).toMatchObject({ available: true, error: null })
  )
  await act(async () => {
    await result.current.start({ id: "project-1" } as EvalProject)
  })
  expect(runtime.start).toHaveBeenCalledWith({ id: "project-1" })
  expect(result.current.experimentId).toBe("exp-1")
  await act(async () => {
    await result.current.cancel()
  })
  expect(runtime.cancel).toHaveBeenCalledWith("exp-1")
  unmount()
  expect(unsubscribe).toHaveBeenCalled()
  expect(runtime.dispose).not.toHaveBeenCalled()
})

it("reattaches to a recovered execution and updates progress through subscription", async () => {
  runtime.recover.mockResolvedValue([{ experimentId: "exp-owned", state: "running" }])
  const { result } = renderHook(() => useEvalExecution())
  await waitFor(() => expect(result.current.experimentId).toBe("exp-owned"))
  act(() =>
    onStatus({
      experimentId: "exp-owned",
      state: "running",
      total: 5,
      completed: 3,
      spentCost: 1,
      reservedCost: 0,
      budgetCap: 2,
    })
  )
  expect(result.current.status.completed).toBe(3)
  expect(runtime.start).not.toHaveBeenCalled()
})

it("discards a report that resolves after selecting a different experiment", async () => {
  let resolveOld!: (report: { experiment: { id: string } }) => void
  runtime.report.mockImplementation((id) =>
    id === "old"
      ? new Promise((resolve) => {
          resolveOld = resolve
        })
      : Promise.resolve({ experiment: { id } })
  )
  const { result } = renderHook(() => useEvalExecution())
  await waitFor(() =>
    expect({
      available: result.current.available,
      error: result.current.error,
      scope: result.current.scopeKey,
    }).toMatchObject({ available: true, error: null })
  )
  let oldSelection!: Promise<boolean>
  act(() => {
    oldSelection = result.current.select("old")
  })
  await waitFor(() => expect(resolveOld).toBeDefined())
  await act(async () => {
    await result.current.select("new")
  })
  await act(async () => {
    resolveOld({ experiment: { id: "old" } })
    await oldSelection
  })
  expect(result.current.reportView?.experiment.id).toBe("new")
})

it("clears report state on a routing-generation change and ignores old subscription events", async () => {
  const { result } = renderHook(() => useEvalExecution())
  await waitFor(() =>
    expect({
      available: result.current.available,
      error: result.current.error,
      scope: result.current.scopeKey,
    }).toMatchObject({ available: true, error: null })
  )
  await act(async () => {
    await result.current.select("old")
  })
  const previousListener = onStatus
  act(() => {
    scope = { ...scope, routingGeneration: 2 }
    for (const listener of listeners) listener()
  })
  await waitFor(() => expect(result.current.experimentId).toBeNull())
  act(() => previousListener({ experimentId: "old", state: "completed", total: 1, completed: 1 }))
  expect(result.current.reportView).toBeNull()
  expect(result.current.status.state).toBe("draft")
})

it("rebinds on an account revision change even when the route stays identical", async () => {
  const { result, rerender } = renderHook(() => useEvalExecution())
  await waitFor(() =>
    expect({
      available: result.current.available,
      error: result.current.error,
      scope: result.current.scopeKey,
    }).toMatchObject({ available: true, error: null })
  )
  await act(async () => {
    await result.current.select("old")
  })
  accountRevision += 1
  rerender()
  await waitFor(() => expect(result.current.experimentId).toBeNull())
  expect(result.current.reportView).toBeNull()
  expect(runtime.recover).toHaveBeenCalledTimes(2)
})

it("immediately hides execution data when the account locks before route cleanup", async () => {
  const { result, rerender } = renderHook(() => useEvalExecution())
  await waitFor(() => expect(result.current.available).toBe(true))
  await act(async () => {
    await result.current.select("private")
  })
  locked = true
  rerender()
  expect(result.current.available).toBe(false)
  expect(result.current.reportView).toBeNull()
  expect(result.current.experimentId).toBeNull()
})

it("surfaces background execution errors from status notifications", async () => {
  const { result } = renderHook(() => useEvalExecution())
  await waitFor(() => expect(result.current.available).toBe(true))
  await act(async () => {
    await result.current.select("failed")
  })
  await act(async () => {
    onStatus({ experimentId: "failed", state: "failed", error: "provider unavailable" })
  })
  expect(result.current.error).toBe("provider unavailable")
})

it("discards a control result after leaving and reselecting the same experiment", async () => {
  let finish!: () => void
  runtime.pause.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { result } = renderHook(() => useEvalExecution())
  await waitFor(() => expect(result.current.available).toBe(true))
  await act(async () => {
    await result.current.select("same")
  })
  let pending!: ReturnType<typeof result.current.pause>
  act(() => {
    pending = result.current.pause()
  })
  await act(async () => {
    await result.current.select("other")
    await result.current.select("same")
  })
  runtime.status.mockResolvedValueOnce({
    experimentId: "same",
    state: "paused",
    total: 9,
    completed: 0,
    spentCost: 0,
    reservedCost: 0,
    budgetCap: 2,
  })
  await act(async () => {
    finish()
    await pending
  })
  expect(result.current.status.state).toBe("running")
  expect(result.current.status.total).toBe(1)
})

it("keeps the subscription active when the same experiment is reselected", async () => {
  const { result } = renderHook(() => useEvalExecution())
  await waitFor(() => expect(result.current.available).toBe(true))
  await act(async () => {
    await result.current.select("same")
  })
  await act(async () => {
    await result.current.select("same")
  })
  act(() =>
    onStatus({
      experimentId: "same",
      state: "running",
      total: 3,
      completed: 2,
      spentCost: 0,
      reservedCost: 0,
      budgetCap: 2,
    })
  )
  expect(result.current.status.completed).toBe(2)
})
