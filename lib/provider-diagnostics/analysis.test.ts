import {
  buildDiagnosticMatrix,
  collectFilterOptions,
  filterDiagnosticSamples,
  rangeStartMs,
  selectDiagnosticTrend,
  trendDurationMs,
  type ProviderDiagnosticFilters,
} from "./analysis"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60_000

function sample(overrides: Partial<ProviderDiagnosticSample> = {}): ProviderDiagnosticSample {
  return {
    id: "s1",
    jobId: "j1",
    targetId: "t1",
    providerId: "openai",
    capability: "text-generation",
    credentialFingerprint: "credential:openai:primary",
    endpoint: "https://api.openai.com/v1",
    startedAt: NOW,
    status: "completed",
    sampleRole: "measured",
    ...overrides,
  } as ProviderDiagnosticSample
}

const ALL: ProviderDiagnosticFilters = {
  status: "all",
  modelId: "all",
  capability: "all",
  credentialFingerprint: "all",
  endpoint: "all",
  range: "all",
}

describe("rangeStartMs", () => {
  it("returns 0 for the unbounded range", () => {
    expect(rangeStartMs("all", NOW)).toBe(0)
  })

  it("walks back one day for 24h and seven for 7d", () => {
    expect(rangeStartMs("24h", NOW)).toBe(NOW - DAY)
    expect(rangeStartMs("7d", NOW)).toBe(NOW - 7 * DAY)
  })
})

describe("filterDiagnosticSamples", () => {
  const rows = [
    sample({ id: "a", modelId: "gpt-5", status: "completed" }),
    sample({ id: "b", modelId: "gpt-4", status: "failed" }),
    sample({ id: "c", modelId: "gpt-5", capability: "embedding" }),
  ]

  it("passes everything through when every axis is 'all'", () => {
    expect(filterDiagnosticSamples(rows, ALL, NOW).map((s) => s.id)).toEqual(["a", "b", "c"])
  })

  it("narrows by status", () => {
    expect(
      filterDiagnosticSamples(rows, { ...ALL, status: "failed" }, NOW).map((s) => s.id)
    ).toEqual(["b"])
  })

  it("narrows by model", () => {
    expect(
      filterDiagnosticSamples(rows, { ...ALL, modelId: "gpt-5" }, NOW).map((s) => s.id)
    ).toEqual(["a", "c"])
  })

  it("narrows by capability", () => {
    expect(
      filterDiagnosticSamples(rows, { ...ALL, capability: "embedding" }, NOW).map((s) => s.id)
    ).toEqual(["c"])
  })

  it("narrows by credential and endpoint", () => {
    const mixed = [sample({ id: "a" }), sample({ id: "b", credentialFingerprint: "other" })]
    expect(
      filterDiagnosticSamples(mixed, { ...ALL, credentialFingerprint: "other" }, NOW).map(
        (s) => s.id
      )
    ).toEqual(["b"])
    expect(
      filterDiagnosticSamples(mixed, { ...ALL, endpoint: "https://api.openai.com/v1" }, NOW).map(
        (s) => s.id
      )
    ).toEqual(["a", "b"])
  })

  it("drops samples older than the range", () => {
    const rowsWithOld = [sample({ id: "fresh" }), sample({ id: "old", startedAt: NOW - 3 * DAY })]
    expect(
      filterDiagnosticSamples(rowsWithOld, { ...ALL, range: "24h" }, NOW).map((s) => s.id)
    ).toEqual(["fresh"])
    expect(
      filterDiagnosticSamples(rowsWithOld, { ...ALL, range: "7d" }, NOW).map((s) => s.id)
    ).toEqual(["fresh", "old"])
  })

  it("hides everything when an axis names a value no sample carries", () => {
    // Better to show an empty list than to silently widen back to "all".
    expect(filterDiagnosticSamples(rows, { ...ALL, modelId: "deleted-model" }, NOW)).toEqual([])
  })
})

describe("buildDiagnosticMatrix", () => {
  const fast = sample({
    id: "fast",
    targetId: "fast",
    metrics: { ttftMs: 100, outputTokensPerSecond: 10, estimatedCostUsd: 0.9 },
  } as Partial<ProviderDiagnosticSample>)
  const slow = sample({
    id: "slow",
    targetId: "slow",
    metrics: { ttftMs: 900, outputTokensPerSecond: 90, estimatedCostUsd: 0.1 },
  } as Partial<ProviderDiagnosticSample>)

  it("groups one row per target", () => {
    const rows = buildDiagnosticMatrix([fast, slow], "interactive")
    expect(rows.map((r) => r.targetId)).toEqual(["fast", "slow"])
    expect(rows[0].summary.measuredSamples).toBe(1)
  })

  it("ranks lowest time-to-first-token first for interactive use", () => {
    expect(buildDiagnosticMatrix([slow, fast], "interactive")[0].targetId).toBe("fast")
  })

  it("ranks highest throughput first for batch use", () => {
    expect(buildDiagnosticMatrix([fast, slow], "batch")[0].targetId).toBe("slow")
  })

  it("ranks lowest cost first for economy use", () => {
    expect(buildDiagnosticMatrix([fast, slow], "economy")[0].targetId).toBe("slow")
  })

  it("sorts unmeasured targets last so they are never recommended", () => {
    const bare = sample({ id: "bare", targetId: "bare" })
    expect(buildDiagnosticMatrix([bare, fast], "interactive").map((r) => r.targetId)).toEqual([
      "fast",
      "bare",
    ])
    expect(buildDiagnosticMatrix([bare, fast], "batch").map((r) => r.targetId)).toEqual([
      "fast",
      "bare",
    ])
    expect(buildDiagnosticMatrix([bare, fast], "economy").map((r) => r.targetId)).toEqual([
      "fast",
      "bare",
    ])
  })

  it("returns nothing for an empty sample set", () => {
    expect(buildDiagnosticMatrix([], "interactive")).toEqual([])
  })
})

describe("trendDurationMs", () => {
  it("prefers the measured total duration", () => {
    expect(
      trendDurationMs(
        sample({
          metrics: { totalDurationMs: 42 },
          probe: { durationMs: 7 },
        } as Partial<ProviderDiagnosticSample>)
      )
    ).toBe(42)
  })

  it("falls back to the probe duration", () => {
    expect(
      trendDurationMs(sample({ probe: { durationMs: 7 } } as Partial<ProviderDiagnosticSample>))
    ).toBe(7)
  })

  it("is 0 when neither exists", () => {
    expect(trendDurationMs(sample())).toBe(0)
  })
})

describe("selectDiagnosticTrend", () => {
  it("keeps only timed samples and reverses them into timeline order", () => {
    const rows = [
      sample({
        id: "newest",
        metrics: { totalDurationMs: 30 },
      } as Partial<ProviderDiagnosticSample>),
      sample({ id: "untimed" }),
      sample({ id: "oldest", probe: { durationMs: 10 } } as Partial<ProviderDiagnosticSample>),
    ]
    const trend = selectDiagnosticTrend(rows)
    expect(trend.samples.map((s) => s.id)).toEqual(["oldest", "newest"])
    expect(trend.maxDurationMs).toBe(30)
  })

  it("honours the limit before reversing", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      sample({
        id: `s${i}`,
        metrics: { totalDurationMs: i + 1 },
      } as Partial<ProviderDiagnosticSample>)
    )
    expect(selectDiagnosticTrend(rows, 5).samples.map((s) => s.id)).toEqual([
      "s4",
      "s3",
      "s2",
      "s1",
      "s0",
    ])
  })

  it("never yields a zero scale, so bar heights cannot divide by zero", () => {
    expect(selectDiagnosticTrend([]).maxDurationMs).toBe(1)
    expect(
      selectDiagnosticTrend([
        sample({ metrics: { totalDurationMs: 0 } } as Partial<ProviderDiagnosticSample>),
      ]).maxDurationMs
    ).toBe(1)
  })
})

describe("collectFilterOptions", () => {
  it("collects distinct values per axis and skips missing model ids", () => {
    const rows = [
      sample({ modelId: "gpt-5", endpoint: "a" }),
      sample({ modelId: "gpt-5", endpoint: "b", credentialFingerprint: "other" }),
      sample({ endpoint: "a" }),
    ]
    expect(collectFilterOptions(rows)).toEqual({
      models: ["gpt-5"],
      credentials: ["credential:openai:primary", "other"],
      endpoints: ["a", "b"],
    })
  })

  it("returns empty axes for no samples", () => {
    expect(collectFilterOptions([])).toEqual({ models: [], credentials: [], endpoints: [] })
  })
})
