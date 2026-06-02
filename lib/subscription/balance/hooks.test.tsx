/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { BalanceSnapshot } from "@/types/subscription"

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => useLiveQueryMock() }))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

const queryAccountBalanceMock = jest.fn()
jest.mock("./runner", () => ({
  queryAccountBalance: (...a: unknown[]) => queryAccountBalanceMock(...a),
}))

const recordBalanceSnapshotMock = jest.fn()
jest.mock("./store", () => ({
  recordBalanceSnapshot: (...a: unknown[]) => recordBalanceSnapshotMock(...a),
}))

import { useAccountBalance } from "./hooks"

function snap(over: Partial<BalanceSnapshot> = {}): BalanceSnapshot {
  return {
    fetchedAt: 1000,
    providerKey: "deepseek",
    accountId: "acc-1",
    kind: "credit",
    remaining: 42,
    raw: {},
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  useLiveQueryMock.mockReturnValue(null)
})

describe("useAccountBalance", () => {
  it("exposes the live snapshot", () => {
    useLiveQueryMock.mockReturnValue(snap())
    const { result } = renderHook(() => useAccountBalance("codex", "acc-1"))
    expect(result.current.snapshot?.remaining).toBe(42)
  })

  it("refreshes: queries the runner and persists the result", async () => {
    queryAccountBalanceMock.mockResolvedValue(snap())
    const { result } = renderHook(() => useAccountBalance("codex", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAccountBalanceMock).toHaveBeenCalledWith("codex", "acc-1")
    expect(recordBalanceSnapshotMock).toHaveBeenCalledTimes(1)
    expect(result.current.unavailable).toBe(false)
  })

  it("marks unavailable when the runner returns null", async () => {
    queryAccountBalanceMock.mockResolvedValue(null)
    const { result } = renderHook(() => useAccountBalance("codex", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(recordBalanceSnapshotMock).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.unavailable).toBe(true))
  })

  it("is a no-op outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useAccountBalance("codex", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAccountBalanceMock).not.toHaveBeenCalled()
  })
})
