/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { ProviderLimits } from "@/types/subscription"

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => useLiveQueryMock() }))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

const queryAccountLimitsMock = jest.fn()
jest.mock("./runner", () => ({
  queryAccountLimits: (...a: unknown[]) => queryAccountLimitsMock(...a),
}))

const queryAllConfiguredLimitsMock = jest.fn()
jest.mock("./aggregate", () => ({
  queryAllConfiguredLimits: (...a: unknown[]) => queryAllConfiguredLimitsMock(...a),
}))

const recordLimitsSnapshotMock = jest.fn()
jest.mock("./store", () => ({
  recordLimitsSnapshot: (...a: unknown[]) => recordLimitsSnapshotMock(...a),
}))

import { useAllConfiguredLimits, useProviderLimits } from "./hooks"

function snap(over: Partial<ProviderLimits> = {}): ProviderLimits {
  return { provider: "anthropic", accountId: "acc-1", fetchedAt: 1000, meters: [], ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  useLiveQueryMock.mockReturnValue(null)
})

describe("useProviderLimits", () => {
  it("exposes the live snapshot", () => {
    useLiveQueryMock.mockReturnValue(snap())
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    expect(result.current.snapshot?.accountId).toBe("acc-1")
  })

  it("refreshes: queries the runner and persists the result", async () => {
    queryAccountLimitsMock.mockResolvedValue(snap())
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAccountLimitsMock).toHaveBeenCalledWith("anthropic", "acc-1")
    expect(recordLimitsSnapshotMock).toHaveBeenCalledTimes(1)
    expect(result.current.unavailable).toBe(false)
  })

  it("marks unavailable when the runner returns null", async () => {
    queryAccountLimitsMock.mockResolvedValue(null)
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(recordLimitsSnapshotMock).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.unavailable).toBe(true))
  })

  it("is a no-op outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAccountLimitsMock).not.toHaveBeenCalled()
  })
})

describe("useAllConfiguredLimits", () => {
  it("aggregates and persists each snapshot", async () => {
    queryAllConfiguredLimitsMock.mockResolvedValue([snap(), snap({ accountId: "acc-2" })])
    const { result } = renderHook(() => useAllConfiguredLimits("anthropic"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAllConfiguredLimitsMock).toHaveBeenCalledWith({ activeProvider: "anthropic" })
    expect(result.current.snapshots).toHaveLength(2)
    expect(recordLimitsSnapshotMock).toHaveBeenCalledTimes(2)
  })

  it("is a no-op outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useAllConfiguredLimits())
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAllConfiguredLimitsMock).not.toHaveBeenCalled()
  })
})
