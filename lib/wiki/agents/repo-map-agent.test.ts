/**
 * Coverage for `RepoMapAgent` — pure heuristic ranking.
 */

import { __TESTING__, buildModuleStats, chunksWithinBudget } from "./repo-map-agent"
import type { CodeChunk } from "../types"

function chunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: overrides.id ?? "c1",
    filePath: overrides.filePath ?? "lib/foo/index.ts",
    module: overrides.module ?? "lib/foo",
    lineStart: overrides.lineStart ?? 1,
    lineEnd: overrides.lineEnd ?? 10,
    tokenCount: overrides.tokenCount ?? 50,
    content: overrides.content ?? "",
    fileHash: overrides.fileHash ?? "h",
  }
}

describe("buildModuleStats", () => {
  it("returns an empty array for empty input", () => {
    expect(buildModuleStats([])).toEqual([])
  })

  it("aggregates chunks under the same module", () => {
    const stats = buildModuleStats([
      chunk({ id: "1", module: "lib/a", filePath: "lib/a/x.ts", lineStart: 1, lineEnd: 10 }),
      chunk({ id: "2", module: "lib/a", filePath: "lib/a/y.ts", lineStart: 1, lineEnd: 10 }),
    ])
    expect(stats).toHaveLength(1)
    expect(stats[0].filePaths).toEqual(["lib/a/x.ts", "lib/a/y.ts"])
    expect(stats[0].totalLines).toBe(20)
  })

  it("normalizes pageRank scores 0..1 with the largest at exactly 1", () => {
    const stats = buildModuleStats([
      chunk({ module: "lib/big", filePath: "lib/big/foo.ts", lineStart: 1, lineEnd: 100 }),
      chunk({ module: "lib/small", filePath: "lib/small/foo.ts", lineStart: 1, lineEnd: 10 }),
    ])
    const big = stats.find((s) => s.module === "lib/big")!
    const small = stats.find((s) => s.module === "lib/small")!
    expect(big.pageRank).toBe(1)
    expect(small.pageRank).toBeGreaterThan(0)
    expect(small.pageRank).toBeLessThan(1)
  })

  it("boosts modules with index/page/route/mod files", () => {
    // Module A has 50 lines but its file is index.ts → boosted ×1.5 = 75
    // Module B has 60 lines from a regular file → 60
    // After boost, A should outrank B.
    const stats = buildModuleStats([
      chunk({
        module: "lib/a",
        filePath: "lib/a/index.ts",
        lineStart: 1,
        lineEnd: 50,
      }),
      chunk({
        module: "lib/b",
        filePath: "lib/b/foo.ts",
        lineStart: 1,
        lineEnd: 60,
      }),
    ])
    const a = stats.find((s) => s.module === "lib/a")!
    const b = stats.find((s) => s.module === "lib/b")!
    expect(a.pageRank).toBeGreaterThan(b.pageRank)
  })

  it("handles modules with zero combined lines (returns pageRank 0)", () => {
    const stats = buildModuleStats([
      chunk({ module: "lib/empty", filePath: "lib/empty/x.ts", lineStart: 5, lineEnd: 5 }),
    ])
    expect(stats[0].totalLines).toBe(1)
    expect(stats[0].pageRank).toBe(1) // single module trivially normalizes to 1
  })

  it("returns stats sorted by pageRank descending", () => {
    const stats = buildModuleStats([
      chunk({ module: "lib/medium", lineStart: 1, lineEnd: 30, filePath: "lib/medium/x.ts" }),
      chunk({ module: "lib/big", lineStart: 1, lineEnd: 100, filePath: "lib/big/x.ts" }),
      chunk({ module: "lib/small", lineStart: 1, lineEnd: 5, filePath: "lib/small/x.ts" }),
    ])
    const ranks = stats.map((s) => s.pageRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
    expect(stats[0].module).toBe("lib/big")
  })
})

describe("chunksWithinBudget", () => {
  it("returns empty for non-positive budget", () => {
    expect(chunksWithinBudget([chunk({ tokenCount: 10 })], 0)).toEqual([])
    expect(chunksWithinBudget([chunk({ tokenCount: 10 })], -5)).toEqual([])
  })

  it("returns all chunks when budget covers them", () => {
    const out = chunksWithinBudget([chunk({ tokenCount: 30 }), chunk({ tokenCount: 40 })], 100)
    expect(out).toHaveLength(2)
  })

  it("stops once adding the next chunk would exceed the budget", () => {
    const out = chunksWithinBudget(
      [chunk({ tokenCount: 30 }), chunk({ tokenCount: 40 }), chunk({ tokenCount: 50 })],
      80
    )
    // 30 + 40 = 70 fits; +50 = 120 doesn't, so stop after 2.
    expect(out).toHaveLength(2)
  })

  it("preserves the input order", () => {
    const c1 = chunk({ id: "1", tokenCount: 10 })
    const c2 = chunk({ id: "2", tokenCount: 20 })
    const c3 = chunk({ id: "3", tokenCount: 5 })
    const out = chunksWithinBudget([c1, c2, c3], 100)
    expect(out.map((c) => c.id)).toEqual(["1", "2", "3"])
  })
})

describe("__TESTING__", () => {
  it("exposes the boost-file set", () => {
    expect(__TESTING__.BOOST_FILES.has("index.ts")).toBe(true)
    expect(__TESTING__.BOOST_FILES.has("page.tsx")).toBe(true)
  })

  it("basenameOf normalizes Windows separators", () => {
    expect(__TESTING__.basenameOf("lib\\foo\\index.ts")).toBe("index.ts")
    expect(__TESTING__.basenameOf("lib/foo/index.ts")).toBe("index.ts")
  })
})
