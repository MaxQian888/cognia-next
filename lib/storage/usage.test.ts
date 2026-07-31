/** @jest-environment jsdom */
import { getStorageUsage, formatBytes } from "./usage"
import type { BackupHistoryRow } from "@/lib/db/backup-history"

function row(sizeBytes: number | undefined, completedAt = Date.now()): BackupHistoryRow {
  return {
    id: `bh_${completedAt}`,
    completedAt,
    type: "manual",
    success: true,
    encryption: "passphrase",
    sizeBytes,
    schemaVersion: 3,
  }
}

describe("getStorageUsage", () => {
  it("reports the estimator values when the API succeeds", async () => {
    const out = await getStorageUsage({
      estimator: async () => ({ usage: 12_345_678, quota: 1_000_000_000 }),
      loadBackups: async () => [],
    })
    expect(out.totalBytes).toBe(12_345_678)
    expect(out.quotaBytes).toBe(1_000_000_000)
    expect(out.backupBytes).toBe(0)
  })

  it("returns null totals when the estimator throws", async () => {
    const out = await getStorageUsage({
      estimator: async () => {
        throw new Error("unsupported")
      },
      loadBackups: async () => [],
    })
    expect(out.totalBytes).toBeNull()
    expect(out.quotaBytes).toBeNull()
  })

  it("sums sizeBytes across the supplied backup rows", async () => {
    const out = await getStorageUsage({
      estimator: async () => ({}),
      loadBackups: async () => [row(1024), row(2048), row(undefined)],
    })
    expect(out.backupBytes).toBe(1024 + 2048)
    expect(out.backups).toHaveLength(3)
  })

  it("returns null backupBytes when the loader rejects", async () => {
    const out = await getStorageUsage({
      estimator: async () => ({}),
      loadBackups: async () => {
        throw new Error("dexie offline")
      },
    })
    expect(out.backupBytes).toBeNull()
    expect(out.backups).toEqual([])
  })

  it("returns null totals when navigator.storage is unavailable", async () => {
    const out = await getStorageUsage({
      estimator: async () => ({}),
      loadBackups: async () => [],
    })
    expect(out.totalBytes).toBeNull()
    expect(out.quotaBytes).toBeNull()
  })
})

describe("formatBytes", () => {
  it.each([
    [null, "—"],
    [undefined, "—"],
    [Number.NaN, "—"],
    [0, "0 B"],
    [512, "512 B"],
    [2048, "2.0 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [2 * 1024 * 1024 * 1024, "2.00 GB"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatBytes(input as number | null | undefined)).toBe(expected)
  })
})
