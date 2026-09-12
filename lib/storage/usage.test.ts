/** @jest-environment jsdom */
import { computeUsageSegments, formatBytes, getStorageUsage, REST_SEGMENT } from "./usage"
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

describe("computeUsageSegments", () => {
  it("scales category shares into the filled part of the quota track", () => {
    const out = computeUsageSegments({
      totalBytes: 250,
      quotaBytes: 1000,
      categories: [
        { category: "chat", totalSize: 60 },
        { category: "skill", totalSize: 40 },
      ],
    })
    expect(out.quotaKnown).toBe(true)
    expect(out.fillPercent).toBe(25)
    expect(out.segments.map((s) => s.category)).toEqual(["chat", "skill"])
    expect(out.segments[0]!.sharePercent).toBe(60)
    // 60% of the 25%-wide filled part.
    expect(out.segments[0]!.widthPercent).toBeCloseTo(15)
    expect(out.segments[1]!.widthPercent).toBeCloseTo(10)
  })

  it("uses the whole track when the quota is unknown", () => {
    const out = computeUsageSegments({
      totalBytes: null,
      quotaBytes: null,
      categories: [{ category: "chat", totalSize: 10 }],
    })
    expect(out.quotaKnown).toBe(false)
    expect(out.fillPercent).toBe(100)
    expect(out.segments[0]!.widthPercent).toBe(100)
  })

  it("merges the tail beyond maxSegments into 'rest' and drops empty categories", () => {
    const out = computeUsageSegments({
      totalBytes: 100,
      quotaBytes: 100,
      maxSegments: 2,
      categories: [
        { category: "a", totalSize: 50 },
        { category: "b", totalSize: 30 },
        { category: "c", totalSize: 15 },
        { category: "d", totalSize: 5 },
        { category: "e", totalSize: 0 },
      ],
    })
    expect(out.segments.map((s) => s.category)).toEqual(["a", "b", REST_SEGMENT])
    expect(out.segments[2]!.bytes).toBe(20)
    expect(out.segments.reduce((s, x) => s + x.widthPercent, 0)).toBeCloseTo(100)
  })

  it("returns no segments when nothing is stored, but still reports the fill", () => {
    const out = computeUsageSegments({ totalBytes: 10, quotaBytes: 100, categories: [] })
    expect(out.segments).toEqual([])
    expect(out.fillPercent).toBe(10)
  })

  it("clamps an over-quota estimate to a full track", () => {
    const out = computeUsageSegments({ totalBytes: 500, quotaBytes: 100, categories: [] })
    expect(out.fillPercent).toBe(100)
  })
})
