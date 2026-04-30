import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useStorageBreakdown } from "./use-storage-breakdown"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useStorageBreakdown", () => {
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
    // Use real timers — fake timers don't advance the microtasks that the
    // initial fetch depends on. We verify the polling fires by waiting for
    // a database write to appear in the surfaced stats after the interval.
    const { result, unmount } = renderHook(() => useStorageBreakdown({ refreshInterval: 50 }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })

    await waitFor(
      () => {
        const bucket = result.current.stats!.byCategory.find((c) => c.category === "backupHistory")
        expect(bucket?.itemCount).toBe(1)
      },
      { timeout: 1500 }
    )
    unmount()
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
})
