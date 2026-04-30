// Live-query wrapper smoke tests. We don't attempt to assert on the exact
// reactivity timing — that's Dexie's contract — but we do verify the hook
// returns the expected snapshot once the underlying query resolves.

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { useBackupHistory, useLatestSuccessfulBackup } from "./use-backup-history"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { appendBackupHistory } from "@/lib/db/backup-history"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
})

describe("useBackupHistory", () => {
  it("returns an empty array when nothing is stored", async () => {
    const { result } = renderHook(() => useBackupHistory())
    expect(Array.isArray(result.current)).toBe(true)
    await waitFor(() => expect(result.current).toEqual([]))
  })

  it("returns rows newest-first once a row is appended", async () => {
    await appendBackupHistory({
      completedAt: 100,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: 200,
      type: "manual",
      success: true,
      encryption: "none",
    })
    const { result } = renderHook(() => useBackupHistory())
    await waitFor(() => expect(result.current.length).toBe(2))
    expect(result.current[0].completedAt).toBe(200)
  })

  it("respects the limit option", async () => {
    for (let i = 1; i <= 5; i++) {
      await appendBackupHistory({
        completedAt: i,
        type: "manual",
        success: true,
        encryption: "none",
      })
    }
    const { result } = renderHook(() => useBackupHistory({ limit: 2 }))
    await waitFor(() => expect(result.current.length).toBe(2))
  })
})

describe("useLatestSuccessfulBackup", () => {
  it("returns undefined when no successful row exists", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: false,
      encryption: "none",
    })
    const { result } = renderHook(() => useLatestSuccessfulBackup())
    await waitFor(() => expect(result.current).toBeUndefined())
  })

  it("returns the newest successful row otherwise", async () => {
    await appendBackupHistory({
      completedAt: 100,
      type: "manual",
      success: true,
      encryption: "none",
      filename: "older.cbk",
    })
    await appendBackupHistory({
      completedAt: 200,
      type: "manual",
      success: true,
      encryption: "none",
      filename: "newer.cbk",
    })
    const { result } = renderHook(() => useLatestSuccessfulBackup())
    await waitFor(() => expect(result.current?.filename).toBe("newer.cbk"))
  })
})
