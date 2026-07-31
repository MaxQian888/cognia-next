/**
 * Unit tests for senderColor — pure deterministic hash → oklch color string.
 * No DOM, no provider required.
 */

import { senderColor } from "./sender-color"

// The HUES array from sender-color.ts (copy for assertion).
const HUES = [
  "oklch(0.7 0.16 15)", // red
  "oklch(0.7 0.13 150)", // green
  "oklch(0.7 0.16 245)", // blue
  "oklch(0.7 0.16 90)", // yellow
  "oklch(0.7 0.13 320)", // purple
  "oklch(0.7 0.13 0)", // orange
  "oklch(0.7 0.13 200)", // teal
  "oklch(0.7 0.13 270)", // violet
] as const

describe("senderColor", () => {
  it("returns a value from the HUES palette for any non-empty name", () => {
    const result = senderColor("Alice")
    expect(HUES).toContain(result)
  })

  it("is deterministic — same name always returns the same color", () => {
    expect(senderColor("Bob")).toBe(senderColor("Bob"))
    expect(senderColor("Claude")).toBe(senderColor("Claude"))
  })

  it("returns distinct colors for names that hash to different buckets", () => {
    // Verify the function discriminates between names (not all-same-bucket).
    const colors = new Set(
      ["Alice", "Bob", "Charlie", "David", "Eve", "Frank", "Grace", "Heidi"].map(senderColor)
    )
    // With 8 names and 8 hues there is no guarantee every one is unique, but
    // in practice the djb2-style hash distributes across at least 3 buckets.
    expect(colors.size).toBeGreaterThan(1)
  })

  it("returns a string starting with 'oklch' for every hue slot", () => {
    // Enumerate names until we've seen all 8 hue slots.
    const seen = new Set<string>()
    let n = 0
    while (seen.size < HUES.length && n < 10_000) {
      const color = senderColor(`name${n}`)
      expect(color).toMatch(/^oklch\(/)
      seen.add(color)
      n++
    }
    expect(seen.size).toBe(HUES.length)
  })

  it("handles a single-character name without throwing", () => {
    expect(() => senderColor("A")).not.toThrow()
    expect(HUES).toContain(senderColor("A"))
  })

  it("handles an empty string without throwing", () => {
    // hash stays 0 → HUES[0]
    expect(() => senderColor("")).not.toThrow()
    expect(senderColor("")).toBe(HUES[0])
  })

  it("handles unicode / multi-byte names", () => {
    const result = senderColor("张伟")
    expect(HUES).toContain(result)
  })

  it("handles very long names", () => {
    const longName = "A".repeat(10_000)
    const result = senderColor(longName)
    expect(HUES).toContain(result)
  })

  it("returns the exact HUES[0] for empty string (hash=0 branch)", () => {
    expect(senderColor("")).toBe("oklch(0.7 0.16 15)")
  })

  it("is not sensitive to reference equality — same palette object", () => {
    // Calling twice should give the same string reference (identical constant).
    const a = senderColor("test")
    const b = senderColor("test")
    expect(a).toBe(b)
  })
})
