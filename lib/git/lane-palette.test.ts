import {
  colorForHash,
  GRAPH_PALETTE_LENGTH,
  hashToColorIndex,
  resolveGraphPalette,
} from "./lane-palette"
import type { ThemeColors } from "@/hooks/logging/use-theme-colors"

const COLORS: ThemeColors = {
  success: "s",
  warning: "w",
  destructive: "d",
  "muted-foreground": "m",
  "chart-1": "c1",
  "chart-2": "c2",
  "chart-3": "c3",
  "chart-4": "c4",
  "chart-5": "c5",
}

describe("resolveGraphPalette", () => {
  it("returns the chart-1..5 colors in order", () => {
    expect(resolveGraphPalette(COLORS)).toEqual(["c1", "c2", "c3", "c4", "c5"])
  })

  it("has GRAPH_PALETTE_LENGTH entries", () => {
    expect(resolveGraphPalette(COLORS)).toHaveLength(GRAPH_PALETTE_LENGTH)
  })
})

describe("hashToColorIndex", () => {
  it("is deterministic for the same hash", () => {
    const a = hashToColorIndex("abc123")
    const b = hashToColorIndex("abc123")
    expect(a).toBe(b)
  })

  it("stays within [0, length)", () => {
    for (const h of ["", "a", "deadbeef", "0".repeat(40), "ZZ", "🚀mix"]) {
      const idx = hashToColorIndex(h)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(GRAPH_PALETTE_LENGTH)
    }
  })

  it("honors a custom length", () => {
    expect(hashToColorIndex("anything", 1)).toBe(0)
    expect(hashToColorIndex("x", 3)).toBeLessThan(3)
  })

  it("guards a non-positive length", () => {
    expect(hashToColorIndex("x", 0)).toBe(0)
    expect(hashToColorIndex("x", -2)).toBe(0)
  })

  it("distributes distinct hashes across more than one bucket", () => {
    const indices = new Set(
      ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg", "hhh"].map((h) => hashToColorIndex(h))
    )
    expect(indices.size).toBeGreaterThan(1)
  })
})

describe("colorForHash", () => {
  it("resolves a hash to a concrete palette color", () => {
    const color = colorForHash(COLORS, "feedface")
    expect(["c1", "c2", "c3", "c4", "c5"]).toContain(color)
  })

  it("is stable for the same hash", () => {
    expect(colorForHash(COLORS, "same")).toBe(colorForHash(COLORS, "same"))
  })
})
