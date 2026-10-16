jest.mock("@/lib/chat/session-archive-writes", () => ({
  deleteManagedDesktopAcceptanceRouted: jest.fn().mockResolvedValue(undefined),
}))
import { deleteManagedDesktopAcceptanceRouted } from "@/lib/chat/session-archive-writes"
import { act, renderHook, waitFor } from "@testing-library/react"
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn(() => ({})) }))
jest.mock("@/lib/execution/managed-desktop-results", () => ({
  syncManagedDesktopAcceptanceResult: jest.fn().mockResolvedValue(true),
}))
jest.mock("@/lib/automation/managed-desktop-results-client", () => ({
  createManagedDesktopResultsScope: jest.fn(),
  managedDesktopEvidenceUrl: jest.fn(),
}))
import {
  createManagedDesktopResultsScope,
  managedDesktopEvidenceUrl,
  type ManagedDesktopAcceptanceResult,
} from "@/lib/automation/managed-desktop-results-client"
import { syncManagedDesktopAcceptanceResult } from "@/lib/execution/managed-desktop-results"
import { useManagedDesktopResults } from "./use-managed-desktop-results"
const record = {
  binding: { acceptanceId: "a" },
  artifacts: [{ id: "image" }],
  humanApprovals: [],
} as unknown as ManagedDesktopAcceptanceResult
let scope: {
  owner: string
  assertActive: jest.Mock
  list: jest.Mock
  readEvidence: jest.Mock
  approve: jest.Mock
  dispose: jest.Mock
}
beforeEach(() => {
  jest.clearAllMocks()
  scope = {
    owner: "owner",
    assertActive: jest.fn(),
    list: jest.fn().mockResolvedValue([record]),
    readEvidence: jest.fn().mockResolvedValue({}),
    approve: jest.fn().mockResolvedValue(record),
    dispose: jest.fn(),
  }
  ;(createManagedDesktopResultsScope as jest.Mock).mockReturnValue(scope)
  ;(syncManagedDesktopAcceptanceResult as jest.Mock).mockResolvedValue(true)
  ;(managedDesktopEvidenceUrl as jest.Mock).mockResolvedValue("blob:private")
  URL.revokeObjectURL = jest.fn()
  crypto.randomUUID = jest.fn(() => "00000000-0000-4000-8000-000000000001")
})
test("loads Host history independent of journal events and imports each child", async () => {
  const { result } = renderHook(() => useManagedDesktopResults({ runId: "parent" }))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.records).toEqual([record])
  expect(scope.list).toHaveBeenCalledWith({
    runId: "parent",
    conversationId: undefined,
    taskId: undefined,
  })
  expect(syncManagedDesktopAcceptanceResult).toHaveBeenCalledWith(record, scope, expect.anything())
})
test("local deletion fences also suppress Host records while acknowledgment is pending", async () => {
  ;(syncManagedDesktopAcceptanceResult as jest.Mock).mockResolvedValue(false)
  const { result } = renderHook(() => useManagedDesktopResults({ runId: "parent" }))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.records).toEqual([])
})
test("explicit image preview revokes on canonical deletion and unmount", async () => {
  const { result, unmount } = renderHook(() => useManagedDesktopResults({ runId: "parent" }))
  await waitFor(() => expect(result.current.records).toHaveLength(1))
  expect(scope.readEvidence).not.toHaveBeenCalled()
  await act(() => result.current.viewEvidence(record, "image"))
  expect(result.current.previews).toEqual({ "a:image": "blob:private" })
  act(() => window.dispatchEvent(new CustomEvent("cognia:managed-desktop-results-deleted")))
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private")
  expect(result.current.previews).toEqual({})
  expect(result.current.records).toEqual([])
  unmount()
  expect(scope.dispose).toHaveBeenCalled()
})
test("account invalidation revokes retained previews and discards a late image", async () => {
  let finish: (url: string) => void = () => undefined
  ;(managedDesktopEvidenceUrl as jest.Mock).mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve
    })
  )
  const { result } = renderHook(() => useManagedDesktopResults({ runId: "parent" }))
  await waitFor(() => expect(result.current.records).toHaveLength(1))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.viewEvidence(record, "image")
  })
  await waitFor(() => expect(managedDesktopEvidenceUrl).toHaveBeenCalled())
  act(() => (createManagedDesktopResultsScope as jest.Mock).mock.calls[0][0]())
  await act(async () => {
    finish("blob:late")
    await pending
  })
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:late")
  expect(result.current.previews).toEqual({})
})
test("human review sends its own revision and preserves agent data", async () => {
  const reviewed = {
    ...record,
    humanApprovals: [{ revision: 4 }],
  } as ManagedDesktopAcceptanceResult
  scope.list.mockResolvedValue([reviewed])
  const { result } = renderHook(() => useManagedDesktopResults({ runId: "parent" }))
  await waitFor(() => expect(result.current.records).toHaveLength(1))
  await act(() => result.current.approve(reviewed, "rejected"))
  expect(scope.approve).toHaveBeenCalledWith("a", 4, "rejected", expect.any(String))
  expect(scope.readEvidence).not.toHaveBeenCalled()
})

test("acceptance deletion uses the canonical history entry point", async () => {
  const target = { ...record, binding: { ...record.binding, sessionId: "session" } }
  const { result } = renderHook(() => useManagedDesktopResults({ runId: "parent" }))
  await waitFor(() => expect(result.current.records).toHaveLength(1))
  await act(() => result.current.remove(target))
  expect(deleteManagedDesktopAcceptanceRouted).toHaveBeenCalledWith("a", "session")
})

test("changing source hides prior evidence and refuses a retained prior action", async () => {
  const { result, rerender } = renderHook(({ runId }) => useManagedDesktopResults({ runId }), {
    initialProps: { runId: "first" },
  })
  await waitFor(() => expect(result.current.records).toHaveLength(1))
  await act(() => result.current.viewEvidence(record, "image"))
  const oldApprove = result.current.approve
  scope.list.mockReturnValue(new Promise(() => undefined))
  rerender({ runId: "second" })
  expect(result.current.records).toEqual([])
  expect(result.current.previews).toEqual({})
  expect(result.current.loading).toBe(true)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private")
  await act(() => oldApprove(record, "approved"))
  expect(scope.approve).not.toHaveBeenCalled()
})

test("an old image request cannot block or clear a new source action", async () => {
  let finishOld!: (value: object) => void
  scope.readEvidence.mockReturnValueOnce(
    new Promise((resolve) => {
      finishOld = resolve
    })
  )
  const { result, rerender } = renderHook(({ runId }) => useManagedDesktopResults({ runId }), {
    initialProps: { runId: "first" },
  })
  await waitFor(() => expect(result.current.records).toHaveLength(1))
  let oldRequest!: Promise<void>
  act(() => {
    oldRequest = result.current.viewEvidence(record, "image")
  })
  rerender({ runId: "second" })
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.approve(record, "rejected"))
  expect(scope.approve).toHaveBeenCalledTimes(1)
  await act(async () => {
    finishOld({})
    await oldRequest
  })
  expect(result.current.previews).toEqual({})
  expect(result.current.busy).toBe(false)
})

test("a delayed approval response never replaces a newer observed revision", async () => {
  jest.useFakeTimers()
  try {
    let finishApproval!: (value: ManagedDesktopAcceptanceResult) => void
    scope.approve.mockReturnValue(
      new Promise((resolve) => {
        finishApproval = resolve
      })
    )
    const { result } = renderHook(() => useManagedDesktopResults({ runId: "parent" }))
    await act(async () => undefined)
    let request!: Promise<void>
    act(() => {
      request = result.current.approve(record, "approved")
    })
    const newer = { ...record, humanApprovals: [{ revision: 2 }] } as ManagedDesktopAcceptanceResult
    scope.list.mockResolvedValue([newer])
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000)
    })
    expect(result.current.records[0].humanApprovals[0].revision).toBe(2)
    await act(async () => {
      finishApproval({
        ...record,
        humanApprovals: [{ revision: 1 }],
      } as ManagedDesktopAcceptanceResult)
      await request
    })
    expect(result.current.records[0].humanApprovals[0].revision).toBe(2)
  } finally {
    jest.useRealTimers()
  }
})
