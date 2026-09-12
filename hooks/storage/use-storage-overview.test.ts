/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import { useStorageOverview } from "./use-storage-overview"
import type { StorageHealth, StorageStats } from "@/lib/storage"

const breakdown = {
  stats: null as StorageStats | null,
  health: null as StorageHealth | null,
  isLoading: true,
  error: null,
  refresh: jest.fn(async () => {}),
  formatBytes: (b: number) => `${b}B`,
}
jest.mock("@/hooks/storage/use-storage-breakdown", () => ({
  useStorageBreakdown: () => breakdown,
}))

const clearCategory = jest.fn(async () => 3)
const cleanup = { clearCategory, isRunning: false }
jest.mock("@/hooks/storage/use-storage-cleanup", () => ({
  useStorageCleanup: () => cleanup,
}))

const usage = { totalBytes: 100, quotaBytes: 1000, backupBytes: 0, backups: [] }

beforeEach(() => {
  breakdown.stats = null
  breakdown.health = null
  breakdown.isLoading = true
  breakdown.refresh.mockClear()
  clearCategory.mockClear()
  cleanup.isRunning = false
})

describe("useStorageOverview", () => {
  it("reads usage + persistence once on mount and leaves the skeleton state", async () => {
    const fetcher = jest.fn(async () => usage)
    const persistedChecker = jest.fn(async () => true)
    breakdown.isLoading = false
    const { result } = renderHook(() => useStorageOverview({ fetcher, persistedChecker }))
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.usage).toEqual(usage)
    expect(result.current.persisted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("refresh() re-reads usage and the breakdown together behind one flag", async () => {
    const fetcher = jest.fn(async () => usage)
    breakdown.isLoading = false
    const { result } = renderHook(() =>
      useStorageOverview({ fetcher, persistedChecker: async () => false })
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => {
      await result.current.refresh()
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(breakdown.refresh).toHaveBeenCalledTimes(1)
    expect(result.current.refreshing).toBe(false)
  })

  it("flips persisted to true when the request is granted", async () => {
    const requester = jest.fn(async () => "persisted" as const)
    breakdown.isLoading = false
    const { result } = renderHook(() =>
      useStorageOverview({
        fetcher: async () => usage,
        persistedChecker: async () => false,
        requester,
      })
    )
    await waitFor(() => expect(result.current.persisted).toBe(false))
    let status: string | undefined
    await act(async () => {
      status = await result.current.requestPersistence()
    })
    expect(status).toBe("persisted")
    expect(result.current.persisted).toBe(true)
  })

  it("leaves persisted false when the request is denied", async () => {
    breakdown.isLoading = false
    const { result } = renderHook(() =>
      useStorageOverview({
        fetcher: async () => usage,
        persistedChecker: async () => false,
        requester: async () => "denied" as const,
      })
    )
    await waitFor(() => expect(result.current.persisted).toBe(false))
    await act(async () => {
      await result.current.requestPersistence()
    })
    expect(result.current.persisted).toBe(false)
  })

  it("clearCategory() clears through the cleanup hook, then refreshes everything", async () => {
    const fetcher = jest.fn(async () => usage)
    breakdown.isLoading = false
    const { result } = renderHook(() =>
      useStorageOverview({ fetcher, persistedChecker: async () => true })
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    let cleared = 0
    await act(async () => {
      cleared = await result.current.clearCategory("chat")
    })
    expect(cleared).toBe(3)
    expect(clearCategory).toHaveBeenCalledWith("chat")
    expect(breakdown.refresh).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("reports busy while a cleanup runs", async () => {
    cleanup.isRunning = true
    breakdown.isLoading = false
    const { result } = renderHook(() =>
      useStorageOverview({ fetcher: async () => usage, persistedChecker: async () => true })
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isBusy).toBe(true)
  })
})
