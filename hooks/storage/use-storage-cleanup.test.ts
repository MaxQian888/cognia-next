import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useStorageCleanup } from "./use-storage-cleanup"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import * as storage from "@/lib/storage"

// Wrap cleanupCategories so individual tests can override timing (the
// "isRunning" lifecycle test needs a deterministic gate). Other tests fall
// through to the real implementation via the default mock factory below.
jest.mock("@/lib/storage", () => {
  const actual = jest.requireActual("@/lib/storage")
  return {
    ...actual,
    cleanupCategories: jest.fn((...args: unknown[]) => actual.cleanupCategories(...args)),
  }
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useStorageCleanup", () => {
  it("toggles isRunning around cleanup operations", async () => {
    // Gate the underlying cleanup so isRunning is deterministically observable
    // mid-flight. Without this, cleanupCategories resolves so quickly that
    // setIsRunning(false) can fire before the test re-reads `result.current`.
    let release: (() => void) | null = null
    const gate = new Promise<void>((res) => {
      release = res as () => void
    })
    const cleanupMock = storage.cleanupCategories as jest.Mock
    cleanupMock.mockImplementationOnce(async () => {
      await gate
      return { freedSpace: 0, deletedItems: 0, details: [], errors: [] }
    })

    const { result } = renderHook(() => useStorageCleanup())
    expect(result.current.isRunning).toBe(false)

    let pending: Promise<unknown> | null = null
    await act(async () => {
      pending = result.current.cleanup({ categories: ["backupHistory"] })
    })
    await waitFor(() => expect(result.current.isRunning).toBe(true))
    ;(release as (() => void) | null)?.()
    await act(async () => {
      await pending
    })
    expect(result.current.isRunning).toBe(false)
  })

  it("preview reports counts without writing", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })

    const { result } = renderHook(() => useStorageCleanup())
    let preview: Awaited<ReturnType<typeof result.current.preview>> | null = null
    await act(async () => {
      preview = await result.current.preview({ categories: ["backupHistory"] })
    })
    expect(preview!.deletedItems).toBe(1)
    expect(await getDb().backupHistory.count()).toBe(1)
  })

  it("clearCategory returns the deleted count", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: 2,
      type: "manual",
      success: true,
      encryption: "none",
    })

    const { result } = renderHook(() => useStorageCleanup())
    let n = 0
    await act(async () => {
      n = await result.current.clearCategory("backupHistory")
    })
    expect(n).toBe(2)
  })

  it("quick + deep cleanups complete without error", async () => {
    const { result } = renderHook(() => useStorageCleanup())
    await act(async () => {
      const q = await result.current.quick()
      const d = await result.current.deep()
      expect(q.errors).toEqual([])
      expect(d.errors).toEqual([])
    })
  })
})
