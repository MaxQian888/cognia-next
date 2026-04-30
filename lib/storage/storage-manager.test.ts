import "fake-indexeddb/auto"
import { StorageManager, __TESTING__ } from "./storage-manager"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  // Drain localStorage so per-test state doesn't bleed between cases.
  if (typeof localStorage !== "undefined") localStorage.clear()
})

describe("StorageManager.formatBytes", () => {
  it("returns 0 B for non-positive / non-finite input", () => {
    expect(StorageManager.formatBytes(0)).toBe("0 B")
    expect(StorageManager.formatBytes(-5)).toBe("0 B")
    expect(StorageManager.formatBytes(Number.NaN)).toBe("0 B")
  })

  it("formats bytes / KB / MB / GB", () => {
    expect(StorageManager.formatBytes(512)).toBe("512 B")
    expect(StorageManager.formatBytes(2048)).toBe("2.0 KB")
    expect(StorageManager.formatBytes(2 * 1024 * 1024)).toBe("2.0 MB")
    expect(StorageManager.formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB")
  })
})

describe("StorageManager.getStats", () => {
  it("returns one bucket per category, including zero-row ones", async () => {
    // After `whenSeeded` the built-in characters/skills/teams are populated,
    // so `byCategory` contains both seeded and empty buckets. We assert the
    // shape (every category present) rather than that everything is zero.
    const stats = await StorageManager.getStats()
    const categoryKeys = stats.byCategory.map((c) => c.category)
    expect(categoryKeys).toContain("settings")
    expect(categoryKeys).toContain("character")
    expect(categoryKeys).toContain("skill")
    expect(stats.localStorage.used).toBe(0)
  })

  it("clearAllCogniaData zeroes every category", async () => {
    await StorageManager.clearAllCogniaData()
    const stats = await StorageManager.getStats()
    expect(stats.byCategory.every((cat) => cat.itemCount === 0)).toBe(true)
    expect(stats.indexedDB.used).toBe(0)
  })

  it("counts rows and bytes for tables under their mapped category", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
      filename: "x.cbk",
    })
    const stats = await StorageManager.getStats()
    const bucket = stats.byCategory.find((c) => c.category === "backupHistory")
    expect(bucket?.itemCount).toBe(1)
    expect(bucket?.totalSize).toBeGreaterThan(0)
    expect(stats.indexedDB.used).toBeGreaterThan(0)
  })

  it("aggregates localStorage size", async () => {
    localStorage.setItem("hello", "world")
    const stats = await StorageManager.getStats()
    expect(stats.localStorage.used).toBeGreaterThan(0)
  })
})

describe("StorageManager.getHealth", () => {
  it("returns healthy when usage is under the warning threshold", async () => {
    const health = await StorageManager.getHealth()
    expect(health.status).toBe("healthy")
    expect(health.issues).toEqual([])
  })

  it("flags warning between 75% and 90%", () => {
    const health = __TESTING__.computeHealth({
      total: { used: 800, quota: 1000, usagePercent: 80 },
      byCategory: [],
      localStorage: { used: 0 },
      indexedDB: { used: 800 },
      generatedAt: 0,
    })
    expect(health.status).toBe("warning")
    expect(health.issues[0].severity).toBe("medium")
  })

  it("flags critical at or over 90%", () => {
    const health = __TESTING__.computeHealth({
      total: { used: 950, quota: 1000, usagePercent: 95 },
      byCategory: [],
      localStorage: { used: 0 },
      indexedDB: { used: 950 },
      generatedAt: 0,
    })
    expect(health.status).toBe("critical")
    expect(health.issues[0].severity).toBe("high")
  })

  it("recommends cleanup for non-system categories over 5MB", () => {
    const health = __TESTING__.computeHealth({
      total: { used: 0, quota: 0, usagePercent: 0 },
      byCategory: [
        {
          category: "chat",
          displayName: "Messages",
          itemCount: 100,
          totalSize: 8 * 1024 * 1024,
          sources: ["messages"],
        },
        {
          category: "settings",
          displayName: "Settings",
          itemCount: 1,
          totalSize: 10 * 1024 * 1024,
          sources: ["settings"],
        },
      ],
      localStorage: { used: 0 },
      indexedDB: { used: 0 },
      generatedAt: 0,
    })
    expect(health.recommendations).toHaveLength(1)
    expect(health.recommendations[0].category).toBe("chat")
    expect(health.recommendations[0].estimatedSavings).toBe(Math.floor(8 * 1024 * 1024 * 0.5))
  })
})

describe("StorageManager.clearAllCogniaData", () => {
  it("empties every Dexie table", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await StorageManager.clearAllCogniaData()
    const stats = await StorageManager.getStats()
    expect(stats.byCategory.every((c) => c.itemCount === 0)).toBe(true)
  })
})

describe("readLocalStorageBytes", () => {
  it("survives a full localStorage iteration", () => {
    expect(__TESTING__.readLocalStorageBytes()).toBe(0)
    localStorage.setItem("a", "x")
    expect(__TESTING__.readLocalStorageBytes()).toBeGreaterThan(0)
  })

  it("returns 0 when localStorage iteration throws (sandbox protection)", () => {
    const fakeStorage = {
      get length() {
        throw new Error("blocked")
      },
      key: () => null,
      getItem: () => null,
    }
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeStorage,
      configurable: true,
      writable: true,
    })
    try {
      expect(__TESTING__.readLocalStorageBytes()).toBe(0)
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
        writable: true,
      })
    }
  })

  it("skips entries with a null key", () => {
    const fakeStorage = {
      length: 1,
      key: () => null,
      getItem: () => "ignored",
    }
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeStorage,
      configurable: true,
      writable: true,
    })
    try {
      expect(__TESTING__.readLocalStorageBytes()).toBe(0)
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
        writable: true,
      })
    }
  })

  it("counts a key whose getItem returns null as zero-length value", () => {
    const fakeStorage = {
      length: 1,
      key: () => "k",
      getItem: () => null,
    }
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeStorage,
      configurable: true,
      writable: true,
    })
    try {
      // Just the 1-char key, value defaults to "" — so total = (1 + 0) * 2 = 2.
      expect(__TESTING__.readLocalStorageBytes()).toBe(2)
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
        writable: true,
      })
    }
  })
})

describe("readQuota fallbacks (storage-manager.ts:36-44)", () => {
  it("returns zeroes when navigator is undefined", async () => {
    const originalNav = globalThis.navigator
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
      writable: true,
    })
    try {
      // getStats reads quota internally; assert the snapshot is zeroed.
      const stats = await StorageManager.getStats()
      expect(stats.total).toEqual({ used: 0, quota: 0, usagePercent: 0 })
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNav,
        configurable: true,
        writable: true,
      })
    }
  })

  it("returns zeroes when navigator.storage.estimate throws", async () => {
    const originalNav = globalThis.navigator
    Object.defineProperty(globalThis, "navigator", {
      value: {
        storage: {
          estimate: jest.fn(() => Promise.reject(new Error("estimate blocked"))),
        },
      },
      configurable: true,
      writable: true,
    })
    try {
      const stats = await StorageManager.getStats()
      expect(stats.total).toEqual({ used: 0, quota: 0, usagePercent: 0 })
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNav,
        configurable: true,
        writable: true,
      })
    }
  })

  it("computes usagePercent when estimate returns numeric usage + quota", async () => {
    const originalNav = globalThis.navigator
    Object.defineProperty(globalThis, "navigator", {
      value: {
        storage: {
          estimate: jest.fn(() => Promise.resolve({ usage: 250, quota: 1000 })),
        },
      },
      configurable: true,
      writable: true,
    })
    try {
      const stats = await StorageManager.getStats()
      expect(stats.total.used).toBe(250)
      expect(stats.total.quota).toBe(1000)
      expect(stats.total.usagePercent).toBeCloseTo(25)
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNav,
        configurable: true,
        writable: true,
      })
    }
  })

  it("clamps usagePercent to 100 when usage exceeds quota", async () => {
    const originalNav = globalThis.navigator
    Object.defineProperty(globalThis, "navigator", {
      value: {
        storage: {
          estimate: jest.fn(() => Promise.resolve({ usage: 5000, quota: 100 })),
        },
      },
      configurable: true,
      writable: true,
    })
    try {
      const stats = await StorageManager.getStats()
      expect(stats.total.usagePercent).toBe(100)
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNav,
        configurable: true,
        writable: true,
      })
    }
  })
})

describe("buildBreakdown table-read errors (storage-manager.ts:99-101)", () => {
  it("skips a table whose toArray() rejects without crashing the breakdown", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory")
    if (!table) throw new Error("backupHistory table missing")
    const spy = jest
      .spyOn(table, "toArray")
      .mockRejectedValueOnce(new Error("simulated read failure"))

    const stats = await StorageManager.getStats()
    const bucket = stats.byCategory.find((c) => c.category === "backupHistory")
    // We mocked the read failure, so the bucket falls back to itemCount=0.
    expect(bucket?.itemCount).toBe(0)
    spy.mockRestore()
  })

  it("estimateRowSize returns 0 for a circular row that JSON.stringify rejects", async () => {
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory")
    if (!table) throw new Error("backupHistory table missing")
    const cyclic: Record<string, unknown> = { id: "c1", completedAt: 1 }
    cyclic.self = cyclic
    // Return the cyclic row from toArray() so estimateRowSize hits its catch.
    const spy = jest.spyOn(table, "toArray").mockResolvedValueOnce([cyclic])
    const stats = await StorageManager.getStats()
    const bucket = stats.byCategory.find((c) => c.category === "backupHistory")
    // 1 row counted, but bytes==0 because JSON.stringify threw on the cycle.
    expect(bucket?.itemCount).toBe(1)
    expect(bucket?.totalSize).toBe(0)
    spy.mockRestore()
  })
})

describe("clearAllCogniaData table-clear failures (storage-manager.ts:180-181)", () => {
  it("continues when one table.clear() rejects mid-transaction", async () => {
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory")
    if (!table) throw new Error("backupHistory table missing")
    const spy = jest
      .spyOn(table, "clear")
      .mockRejectedValueOnce(new Error("simulated clear failure"))

    // Should swallow the per-table failure and still resolve.
    await expect(StorageManager.clearAllCogniaData()).resolves.toBeUndefined()
    spy.mockRestore()
  })
})
