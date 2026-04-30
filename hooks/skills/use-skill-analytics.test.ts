/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const liveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(fn: () => Promise<T> | T): T | undefined => liveQueryMock(fn) as T | undefined,
}))

jest.mock("@/lib/db/skills", () => ({
  listSkills: jest.fn(async () => []),
  inferCategory: (r: { category?: string }) => r.category ?? "general",
  inferSource: (r: { source?: string }) => r.source ?? "local",
}))

import { useSkillAnalytics } from "./use-skill-analytics"

beforeEach(() => {
  liveQueryMock.mockReset()
})

describe("useSkillAnalytics", () => {
  it("returns the loading shape when rows are undefined", () => {
    liveQueryMock.mockReturnValue(undefined)
    const { result } = renderHook(() => useSkillAnalytics())
    expect(result.current.loading).toBe(true)
    expect(result.current.totalSkills).toBe(0)
    expect(result.current.mostUsed).toEqual([])
    expect(result.current.byCategory).toEqual([])
    expect(result.current.bySource).toEqual([])
  })

  it("aggregates totals, splits, and slicing limits", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      name: `S${i}`,
      content: "x".repeat(40),
      category: i % 2 === 0 ? "writing" : "code",
      source: "local",
      status: i < 10 ? "enabled" : "disabled",
      usageCount: i,
      lastUsedAt: i,
    }))
    liveQueryMock.mockReturnValue(rows)
    const { result } = renderHook(() => useSkillAnalytics())
    expect(result.current.loading).toBe(false)
    expect(result.current.totalSkills).toBe(12)
    expect(result.current.totalEnabled).toBe(10)
    // sum of 0..11 == 66
    expect(result.current.totalUsage).toBe(66)
    // Each row has 40 chars / 4 chars-per-token = 10 tokens × 12 = 120
    expect(result.current.estimatedTokens).toBe(120)
    expect(result.current.mostUsed).toHaveLength(8)
    expect(result.current.recentlyUsed).toHaveLength(8)
    expect(result.current.neverUsed.map((r) => r.id)).toEqual(["s0"])
    expect(result.current.byCategory.length).toBe(2)
    // All rows are local
    expect(result.current.bySource).toEqual([{ source: "local", count: 12, usage: 66 }])
  })

  it("treats missing usageCount/status as 0/enabled", () => {
    liveQueryMock.mockReturnValue([{ id: "a", name: "A", category: "writing", source: "local" }])
    const { result } = renderHook(() => useSkillAnalytics())
    expect(result.current.totalEnabled).toBe(1)
    expect(result.current.totalUsage).toBe(0)
    expect(result.current.neverUsed.map((r) => r.id)).toEqual(["a"])
    expect(result.current.recentlyUsed).toEqual([])
  })
})
