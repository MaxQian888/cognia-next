/**
 * Aggregation-helper tests for the Twin overview card. We don't render
 * recharts here — that adds significant overhead without buying us much
 * (the visual surface is small + driven entirely by the buckets we
 * compute). Instead we exercise the four aggregators that do the actual
 * data shaping.
 */

import { __TESTING__ } from "./twin-overview-card"
import type { TwinChunk, TwinSource } from "@/types/twin"

const { buildGrowthSeries, buildKindBreakdown, buildStrategyBreakdown, buildStatusBreakdown } =
  __TESTING__

function chunk(overrides: Partial<TwinChunk>): TwinChunk {
  return {
    id: overrides.id ?? "c1",
    twinId: "twin_x",
    sourceId: "src_1",
    content: "x",
    contentRedacted: "x",
    charStart: 0,
    charEnd: 1,
    vectorBackend: "qdrant",
    vectorCollection: "c",
    vectorDocId: "vec_1",
    strategy: "paragraph",
    tokenCount: 1,
    metadata: {},
    createdAt: Date.now(),
    ...overrides,
  }
}

function source(overrides: Partial<TwinSource>): TwinSource {
  return {
    id: overrides.id ?? "s1",
    twinId: "twin_x",
    kind: "document",
    format: "markdown",
    source: "manual",
    title: "demo",
    bytes: 0,
    fingerprint: "fp",
    chunkCount: 0,
    status: "parsed",
    importedAt: Date.now(),
    redacted: false,
    ...overrides,
  }
}

describe("buildGrowthSeries", () => {
  it("emits 7 buckets back to today regardless of input volume", () => {
    const series = buildGrowthSeries([])
    expect(series).toHaveLength(7)
  })

  it("counts chunks created today against today's bucket", () => {
    const today = chunk({ id: "c1", createdAt: Date.now() })
    const series = buildGrowthSeries([today])
    expect(series[series.length - 1].chunks).toBe(1)
  })

  it("ignores chunks older than the 7-day window", () => {
    const old = chunk({ id: "c1", createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000 })
    const series = buildGrowthSeries([old])
    const total = series.reduce((sum, b) => sum + b.chunks, 0)
    expect(total).toBe(0)
  })
})

describe("buildKindBreakdown", () => {
  it("counts each non-deleted source's kind", () => {
    const out = buildKindBreakdown([
      source({ id: "s1", kind: "document" }),
      source({ id: "s2", kind: "document" }),
      source({ id: "s3", kind: "chat" }),
      source({ id: "s4", kind: "code", status: "deleted" }),
    ])
    const map = Object.fromEntries(out.map((b) => [b.kind, b.count]))
    expect(map.document).toBe(2)
    expect(map.chat).toBe(1)
    expect(map.code).toBeUndefined()
  })

  it("returns empty list when no kinds have rows", () => {
    expect(buildKindBreakdown([])).toEqual([])
  })
})

describe("buildStrategyBreakdown", () => {
  it("sorts strategies by count, highest first", () => {
    const out = buildStrategyBreakdown([
      chunk({ id: "c1", strategy: "paragraph" }),
      chunk({ id: "c2", strategy: "code" }),
      chunk({ id: "c3", strategy: "code" }),
      chunk({ id: "c4", strategy: "code" }),
    ])
    expect(out[0].strategy).toBe("code")
    expect(out[0].count).toBe(3)
    expect(out[1].strategy).toBe("paragraph")
  })
})

describe("buildStatusBreakdown", () => {
  it("returns per-status counts", () => {
    const out = buildStatusBreakdown([
      source({ id: "s1", status: "parsed" }),
      source({ id: "s2", status: "parsed" }),
      source({ id: "s3", status: "failed" }),
    ])
    expect(out.parsed).toBe(2)
    expect(out.failed).toBe(1)
    expect(out.pending).toBeUndefined()
  })
})
