import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useStorageBreakdown } from "./use-storage-breakdown"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { StorageManager, type StorageStats } from "@/lib/storage"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useStorageBreakdown", () => {
  it("walks once and derives health from that exact snapshot on mount and refresh", async () => {
    const read = jest.spyOn(StorageManager, "getStats")
    const health = jest.spyOn(StorageManager, "getHealth")
    const { result, unmount } = renderHook(() => useStorageBreakdown())
    try {
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      expect(read).toHaveBeenCalledTimes(1)
      expect(health).toHaveBeenLastCalledWith(result.current.stats)
      read.mockClear()
      health.mockClear()
      await act(async () => result.current.refresh())
      expect(read).toHaveBeenCalledTimes(1)
      expect(health).toHaveBeenLastCalledWith(result.current.stats)
    } finally {
      unmount()
      read.mockRestore()
      health.mockRestore()
    }
  })

  it("loads stats + health on mount", async () => {
    const { result } = renderHook(() => useStorageBreakdown())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.stats).not.toBeNull()
    expect(result.current.health).not.toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.formatBytes(2048)).toBe("2.0 KB")
  })

  it("refresh re-walks the database after writes", async () => {
    const { result } = renderHook(() => useStorageBreakdown())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })

    await act(async () => {
      await result.current.refresh()
    })
    const bucket = result.current.stats!.byCategory.find((c) => c.category === "backupHistory")
    expect(bucket?.itemCount).toBe(1)
  })

  it("polls when refreshInterval > 0", async () => {
    // The integration cases above verify actual database walks. Keep the
    // interval test focused on polling so a busy runner cannot overlap walks
    // across every table faster than IndexedDB can finish them.
    const stats = await StorageManager.getStats()
    const health = await StorageManager.getHealth()
    const getStats = jest.spyOn(StorageManager, "getStats").mockResolvedValue(stats)
    const getHealth = jest.spyOn(StorageManager, "getHealth").mockResolvedValue(health)
    const { result, unmount } = renderHook(() => useStorageBreakdown({ refreshInterval: 50 }))
    try {
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      getStats.mockResolvedValue({
        ...stats,
        byCategory: stats.byCategory.map((bucket) =>
          bucket.category === "backupHistory" ? { ...bucket, itemCount: 1 } : bucket
        ),
      })
      await waitFor(() => {
        const bucket = result.current.stats!.byCategory.find((c) => c.category === "backupHistory")
        expect(bucket?.itemCount).toBe(1)
      })
    } finally {
      unmount()
      getStats.mockRestore()
      getHealth.mockRestore()
    }
  })

  it("captures errors raised by the manager", async () => {
    const spy = jest.spyOn(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@/lib/storage").StorageManager,
      "getStats"
    )
    spy.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useStorageBreakdown())
    await waitFor(() => expect(result.current.error?.message).toBe("boom"))
    spy.mockRestore()
  })

  it("keeps previous data and loading state when a refresh fails", async () => {
    const { result, unmount } = renderHook(() => useStorageBreakdown())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const previousStats = result.current.stats
    const previousHealth = result.current.health
    const read = jest
      .spyOn(StorageManager, "getStats")
      .mockRejectedValueOnce(new Error("refresh failed"))
    try {
      await act(async () => result.current.refresh())
      expect(result.current.stats).toBe(previousStats)
      expect(result.current.health).toBe(previousHealth)
      expect(result.current.isLoading).toBe(false)
      expect(result.current.error?.message).toBe("refresh failed")
    } finally {
      unmount()
      read.mockRestore()
    }
  })

  it("ignores an initial result after unmount", async () => {
    const stats = await StorageManager.getStats()
    let finish!: (value: StorageStats) => void
    const pending = new Promise<StorageStats>((resolve) => {
      finish = resolve
    })
    const read = jest.spyOn(StorageManager, "getStats").mockReturnValue(pending)
    let renders = 0
    const { unmount } = renderHook(() => {
      renders += 1
      return useStorageBreakdown()
    })
    const before = renders
    unmount()
    try {
      await act(async () => {
        finish(stats)
        await pending
      })
      expect(renders).toBe(before)
    } finally {
      read.mockRestore()
    }
  })

  it("preserves completion-order updates for overlapping refreshes", async () => {
    const { result, unmount } = renderHook(() => useStorageBreakdown())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const initial = result.current.stats!
    const older = { ...initial, generatedAt: initial.generatedAt + 1 }
    const newer = { ...initial, generatedAt: initial.generatedAt + 2 }
    let finishOlder!: (value: StorageStats) => void
    let finishNewer!: (value: StorageStats) => void
    const first = new Promise<StorageStats>((resolve) => {
      finishOlder = resolve
    })
    const second = new Promise<StorageStats>((resolve) => {
      finishNewer = resolve
    })
    const read = jest
      .spyOn(StorageManager, "getStats")
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    try {
      const firstRefresh = result.current.refresh()
      const secondRefresh = result.current.refresh()
      expect(result.current.isLoading).toBe(false)
      await act(async () => {
        finishNewer(newer)
        await secondRefresh
      })
      expect(result.current.stats).toBe(newer)
      await act(async () => {
        finishOlder(older)
        await firstRefresh
      })
      expect(result.current.stats).toBe(older)
    } finally {
      unmount()
      read.mockRestore()
    }
  })
})
