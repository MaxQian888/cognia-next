// Pure-data module: verify the canonical 12 built-in preset rows have the
// invariants the seeder relies on (stable ids, ascending sortOrder, single
// timestamp, uniqueness of ids/categories within expected sets).

import { BUILT_IN_PRESET_IDS, buildBuiltInPresets } from "./preset-built-ins"

describe("buildBuiltInPresets", () => {
  it("returns 12 distinct rows", () => {
    const rows = buildBuiltInPresets(0)
    expect(rows).toHaveLength(12)
    expect(new Set(rows.map((r) => r.id)).size).toBe(12)
  })

  it("stamps every row with the supplied timestamp", () => {
    const rows = buildBuiltInPresets(123456)
    expect(rows.every((r) => r.createdAt === 123456 && r.updatedAt === 123456)).toBe(true)
  })

  it("flags every row as built-in and zeroes the usage counters", () => {
    const rows = buildBuiltInPresets(0)
    for (const r of rows) {
      expect(r.isBuiltIn).toBe(true)
      expect(r.isFavorite).toBe(false)
      expect(r.isDefault).toBe(false)
      expect(r.usageCount).toBe(0)
    }
  })

  it("uses ids prefixed with preset_builtin_", () => {
    const rows = buildBuiltInPresets(0)
    expect(rows.every((r) => r.id.startsWith("preset_builtin_"))).toBe(true)
  })

  it("assigns ascending sortOrder values 0..11", () => {
    const rows = buildBuiltInPresets(0)
    const orders = rows.map((r) => r.sortOrder)
    expect(orders).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it("includes the canonical category set used by the UI filter chips", () => {
    const rows = buildBuiltInPresets(0)
    const cats = new Set(rows.map((r) => r.category))
    expect(cats.has("general")).toBe(true)
    expect(cats.has("coding")).toBe(true)
    expect(cats.has("writing")).toBe(true)
    expect(cats.has("research")).toBe(true)
    expect(cats.has("productivity")).toBe(true)
    expect(cats.has("education")).toBe(true)
    expect(cats.has("business")).toBe(true)
  })

  it("every row carries non-empty content, name, icon, and color", () => {
    const rows = buildBuiltInPresets(0)
    for (const r of rows) {
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.content.length).toBeGreaterThan(0)
      expect(r.icon?.length ?? 0).toBeGreaterThan(0)
      expect(r.color?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

describe("BUILT_IN_PRESET_IDS", () => {
  it("has exactly 12 ids", () => {
    expect(BUILT_IN_PRESET_IDS.size).toBe(12)
  })

  it("contains every id produced by buildBuiltInPresets", () => {
    const rows = buildBuiltInPresets(0)
    for (const r of rows) {
      expect(BUILT_IN_PRESET_IDS.has(r.id)).toBe(true)
    }
  })

  it("does not include made-up ids", () => {
    expect(BUILT_IN_PRESET_IDS.has("preset_builtin_made_up")).toBe(false)
  })
})
