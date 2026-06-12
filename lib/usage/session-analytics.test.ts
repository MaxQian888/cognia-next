import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  CACHE_READ_MULT,
  CACHE_WRITE_MULT,
  aggregateByDay,
  aggregateByModel,
  aggregateBySession,
  buildUsageFilename,
  effectiveCostUsd,
  estimateCostFromTotals,
  filterByRange,
  toUsageCsv,
  toUsageJson,
} from "./session-analytics"

const NOW = Date.UTC(2026, 4, 31, 12, 0, 0)

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    at: NOW,
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 1234,
    ...overrides,
  }
}

// A fixed price table so cost math is deterministic regardless of the real
// pricing tables drifting over time.
const priceFor = (model: string) => (model === "test-model" ? { input: 3, output: 15 } : null)

describe("effectiveCostUsd", () => {
  it("prefers the SDK-reported cost when present", () => {
    expect(effectiveCostUsd(row({ costUsd: 0.42 }), priceFor)).toBe(0.42)
  })

  it("estimates from pricing when SDK cost is 0", () => {
    const cost = effectiveCostUsd(
      row({ costUsd: 0, model: "test-model", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      priceFor
    )
    expect(cost).toBeCloseTo(3 + 15, 6)
  })

  it("adds cache tokens at the Anthropic multipliers", () => {
    const cost = effectiveCostUsd(
      row({
        costUsd: 0,
        model: "test-model",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      }),
      priceFor
    )
    // read: 3 * 0.1, write: 3 * 1.25
    expect(cost).toBeCloseTo(3 * CACHE_READ_MULT + 3 * CACHE_WRITE_MULT, 6)
  })

  it("returns 0 for an unknown model", () => {
    expect(effectiveCostUsd(row({ costUsd: 0, model: "mystery" }), priceFor)).toBe(0)
  })

  it("returns 0 when the model is missing", () => {
    expect(effectiveCostUsd(row({ costUsd: 0, model: undefined }), priceFor)).toBe(0)
  })
})

describe("estimateCostFromTotals", () => {
  const totals = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }

  it("prices summed input/output tokens from the pricing table", () => {
    expect(estimateCostFromTotals(totals, "test-model", priceFor)).toBeCloseTo(3 + 15, 6)
  })

  it("adds cache reads at 0.1x and cache writes at 1.25x the input rate", () => {
    const cost = estimateCostFromTotals(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      },
      "test-model",
      priceFor
    )
    expect(cost).toBeCloseTo(3 * CACHE_READ_MULT + 3 * CACHE_WRITE_MULT, 6)
  })

  it("returns 0 for an unknown or missing model", () => {
    expect(estimateCostFromTotals(totals, "mystery", priceFor)).toBe(0)
    expect(estimateCostFromTotals(totals, undefined, priceFor)).toBe(0)
  })
})

describe("aggregateByModel", () => {
  it("buckets by model and sorts by cost desc", () => {
    const rows = [
      row({ model: "test-model", costUsd: 1, inputTokens: 100, outputTokens: 100 }),
      row({ model: "other", costUsd: 0.5, inputTokens: 10, outputTokens: 10 }),
      row({ model: "test-model", costUsd: 2, inputTokens: 100, outputTokens: 100 }),
    ]
    const out = aggregateByModel(rows, priceFor)
    expect(out.map((m) => m.model)).toEqual(["test-model", "other"])
    expect(out[0]!.turns).toBe(2)
    expect(out[0]!.costUsd).toBe(3)
    expect(out[0]!.inputTokens).toBe(200)
  })

  it("labels rows without a model as (unknown)", () => {
    const out = aggregateByModel([row({ model: undefined, costUsd: 1 })], priceFor)
    expect(out[0]!.model).toBe("(unknown)")
  })
})

describe("aggregateByDay", () => {
  it("buckets by UTC day ascending", () => {
    const day1 = Date.UTC(2026, 4, 30, 23, 0, 0)
    const day2 = Date.UTC(2026, 4, 31, 1, 0, 0)
    const out = aggregateByDay(
      [
        row({ at: day2, costUsd: 2, inputTokens: 10, outputTokens: 0 }),
        row({ at: day1, costUsd: 1, inputTokens: 5, outputTokens: 0 }),
        row({ at: day2, costUsd: 3, inputTokens: 20, outputTokens: 0 }),
      ],
      priceFor
    )
    expect(out.map((d) => d.date)).toEqual(["2026-05-30", "2026-05-31"])
    expect(out[1]!.requests).toBe(2)
    expect(out[1]!.cost).toBe(5)
    expect(out[1]!.tokens).toBe(30)
  })
})

describe("aggregateBySession", () => {
  it("buckets by session, descending by cost", () => {
    const out = aggregateBySession(
      [
        row({ sessionId: "a", costUsd: 1 }),
        row({ sessionId: "b", costUsd: 4 }),
        row({ sessionId: "a", costUsd: 1 }),
      ],
      priceFor
    )
    expect(out.map((s) => s.sessionId)).toEqual(["b", "a"])
    expect(out[1]!.turns).toBe(2)
    expect(out[1]!.costUsd).toBe(2)
  })
})

describe("filterByRange", () => {
  it("keeps all rows when range is null", () => {
    const rows = [row({ at: NOW - 99 * 86_400_000 }), row({ at: NOW })]
    expect(filterByRange(rows, null, NOW)).toHaveLength(2)
  })

  it("drops rows older than the cutoff", () => {
    const rows = [row({ at: NOW - 10 * 86_400_000 }), row({ at: NOW - 2 * 86_400_000 })]
    const out = filterByRange(rows, 7, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]!.at).toBe(NOW - 2 * 86_400_000)
  })
})

describe("export", () => {
  it("emits a header-only CSV for no rows", () => {
    expect(toUsageCsv([])).toBe(
      "messageId,sessionId,characterId,at,model,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,costUsd,durationMs"
    )
  })

  it("escapes commas and quotes in CSV cells", () => {
    const csv = toUsageCsv([row({ messageId: 'a,"b"', sessionId: "s", model: undefined })])
    const lines = csv.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"a,""b"""')
    // Missing model serializes to an empty field.
    expect(lines[1]).toContain(",,") // characterId + model both blank
  })

  it("round-trips JSON", () => {
    const rows = [row({ messageId: "x" })]
    expect(JSON.parse(toUsageJson(rows))).toEqual(rows)
  })

  it("date-stamps the filename", () => {
    expect(buildUsageFilename("csv", NOW)).toBe("cognia-usage-2026-05-31.csv")
    expect(buildUsageFilename("json", NOW)).toBe("cognia-usage-2026-05-31.json")
  })
})
