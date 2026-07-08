/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  cleanupCategories,
  clearCategory,
  deepCleanup,
  previewCleanup,
  quickCleanup,
  selectableCategories,
  __TESTING__,
} from "./cleanup"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

async function seedHistory(rows: number, baseAt = Date.now()) {
  for (let i = 0; i < rows; i += 1) {
    await appendBackupHistory({
      completedAt: baseAt - i * 1000,
      type: "manual",
      success: true,
      encryption: "none",
      filename: `f${i}.cbk`,
    })
  }
}

describe("previewCleanup", () => {
  it("returns zeroes for an empty bucket", async () => {
    // backupHistory starts empty after a fresh seed.
    const result = await previewCleanup({ categories: ["backupHistory"] })
    expect(result.deletedItems).toBe(0)
    expect(result.freedSpace).toBe(0)
    expect(result.details).toEqual([])
  })

  it("counts rows in the requested category without writing", async () => {
    await seedHistory(3)
    const result = await previewCleanup({ categories: ["backupHistory"] })
    expect(result.deletedItems).toBe(3)
    expect(result.freedSpace).toBeGreaterThan(0)
    expect(await getDb().backupHistory.count()).toBe(3)
  })
})

describe("cleanupCategories", () => {
  it("deletes rows in the requested category and returns a per-category detail", async () => {
    await seedHistory(2)
    const result = await cleanupCategories({ categories: ["backupHistory"] })
    expect(result.deletedItems).toBe(2)
    expect(result.details).toHaveLength(1)
    expect(result.details[0].category).toBe("backupHistory")
    expect(await getDb().backupHistory.count()).toBe(0)
  })

  it("respects olderThan and leaves newer rows alone", async () => {
    const now = 10_000
    await appendBackupHistory({
      completedAt: now - 5_000, // old
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: now + 5_000, // new
      type: "manual",
      success: true,
      encryption: "none",
    })
    const result = await cleanupCategories({
      categories: ["backupHistory"],
      olderThan: now,
    })
    expect(result.deletedItems).toBe(1)
    expect(await getDb().backupHistory.count()).toBe(1)
  })

  it("defaults to the selectable category set when none supplied", async () => {
    await seedHistory(2)
    const result = await cleanupCategories()
    // The default set excludes seed-driven buckets (characters/skills/teams),
    // so only the rows we just appended should be deleted. Asserting >= 2
    // keeps the test resilient to future selectableCategories tweaks while
    // still catching regressions that skip the explicit ones.
    expect(result.deletedItems).toBeGreaterThanOrEqual(2)
    expect(await getDb().backupHistory.count()).toBe(0)
  })
})

describe("clearCategory", () => {
  it("returns the count of rows deleted", async () => {
    await seedHistory(4)
    const deleted = await clearCategory("backupHistory")
    expect(deleted).toBe(4)
  })
})

describe("quickCleanup", () => {
  it("only touches transient buckets — leaves backup history alone", async () => {
    await seedHistory(3)
    const result = await quickCleanup()
    expect(result.errors).toEqual([])
    expect(await getDb().backupHistory.count()).toBe(3)
  })
})

describe("deepCleanup", () => {
  it("drops backup history older than the 7-day window", async () => {
    const now = Date.now()
    await appendBackupHistory({
      completedAt: now - __TESTING__.DEEP_CLEANUP_AGE_MS - 1000,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: now - 1000,
      type: "manual",
      success: true,
      encryption: "none",
    })
    const result = await deepCleanup()
    expect(result.deletedItems).toBeGreaterThanOrEqual(1)
    expect(await getDb().backupHistory.count()).toBe(1)
  })
})

describe("selectableCategories", () => {
  it("excludes settings + seed-driven categories", () => {
    const set = selectableCategories()
    expect(set).not.toContain("settings")
    expect(set).not.toContain("character")
    expect(set).toContain("backupHistory")
  })
})

describe("rowSize fallback (cleanup.ts:32-33)", () => {
  it("returns 0 for a circular structure that JSON.stringify rejects", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(__TESTING__.rowSize(cyclic)).toBe(0)
  })

  it("returns the JSON length for normal rows", () => {
    expect(__TESTING__.rowSize({ x: 1 })).toBe(JSON.stringify({ x: 1 }).length)
  })
})

describe("previewCleanup with olderThan filter", () => {
  it("only counts rows older than the cutoff (preview parity with cleanup)", async () => {
    const now = 100_000
    await appendBackupHistory({
      completedAt: now - 5_000, // old
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: now + 5_000, // new — must be skipped
      type: "manual",
      success: true,
      encryption: "none",
    })
    const result = await previewCleanup({
      categories: ["backupHistory"],
      olderThan: now,
    })
    expect(result.deletedItems).toBe(1)
    // Preview is non-destructive — both rows still in the table.
    expect(await getDb().backupHistory.count()).toBe(2)
  })
})

describe("category iteration robustness", () => {
  it("surfaces table.toArray() errors as result.errors entries", async () => {
    await seedHistory(2)
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory")
    if (!table) throw new Error("backupHistory table missing")
    const original = table.toArray.bind(table)
    const spy = jest
      .spyOn(table, "toArray")
      .mockRejectedValueOnce(new Error("simulated read failure"))

    const result = await cleanupCategories({ categories: ["backupHistory"] })
    expect(result.errors.some((e) => e.includes("simulated read failure"))).toBe(true)

    spy.mockRestore()
    void original
  })

  it("surfaces bulkDelete failures as result.errors entries", async () => {
    await seedHistory(2)
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory") as unknown as {
      bulkDelete: (ids: unknown[]) => Promise<unknown>
    }
    const spy = jest
      .spyOn(table, "bulkDelete")
      .mockRejectedValueOnce(new Error("simulated bulkDelete fail"))

    const result = await cleanupCategories({ categories: ["backupHistory"] })
    expect(result.errors.some((e) => e.includes("simulated bulkDelete fail"))).toBe(true)
    spy.mockRestore()
  })

  it("surfaces non-Error throws as String(err) entries", async () => {
    await seedHistory(1)
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory") as unknown as {
      toArray: () => Promise<unknown[]>
    }
    const spy = jest.spyOn(table, "toArray").mockRejectedValueOnce("plain string failure")
    const result = await cleanupCategories({ categories: ["backupHistory"] })
    expect(result.errors.some((e) => e.includes("plain string failure"))).toBe(true)
    spy.mockRestore()
  })
})
