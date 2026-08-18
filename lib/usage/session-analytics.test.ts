import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  CACHE_READ_MULT,
  CACHE_WRITE_MULT,
  aggregateByDay,
  aggregateByModel,
  aggregateBySession,
  analyzeUsageContributors,
  buildUsageFilename,
  effectiveCostUsd,
  effectiveCostUsdDetailed,
  estimateCostFromTotals,
  fillDailyRange,
  filterByRange,
  HIGH_CONTEXT_THRESHOLD,
  localDay,
  parseLocalDay,
  topModelByTokens,
  toUsageCsv,
  toUsageJson,
  type PricingResolver,
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

// A fixed resolver so cost math is deterministic regardless of the real
// pricing tables drifting over time. Shape matches the unified resolver
// (providerId, modelId) → ModelPricing | null.
const priceFor: PricingResolver = (_providerId, model) =>
  model === "test-model" ? { promptPer1M: 3, completionPer1M: 15, currency: "USD" } : null

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

  describe("effectiveCostUsdDetailed", () => {
    it("marks an SDK-reported cost as known", () => {
      expect(effectiveCostUsdDetailed(row({ costUsd: 0.42 }), priceFor)).toEqual({
        cost: 0.42,
        known: true,
        source: "sdk",
      })
    })

    it("marks a locally priced cost as known", () => {
      const out = effectiveCostUsdDetailed(
        row({
          costUsd: 0,
          model: "test-model",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
        priceFor
      )
      expect(out.known).toBe(true)
      expect(out.source).toBe("priced")
      expect(out.cost).toBeCloseTo(3, 6)
    })

    it("distinguishes an unpriced model from a genuinely free one", () => {
      // Both report cost 0; only the first is "we don't know". Rendering the
      // unknown case as $0.00 silently understates spend.
      const unknown = effectiveCostUsdDetailed(row({ costUsd: 0, model: "mystery" }), priceFor)
      expect(unknown).toEqual({ cost: 0, known: false, source: "unknown" })

      const free = effectiveCostUsdDetailed(
        row({ costUsd: 0, model: "free-model", inputTokens: 1_000_000 }),
        (_p, m) =>
          m === "free-model" ? { promptPer1M: 0, completionPer1M: 0, currency: "USD" } : null
      )
      expect(free).toEqual({ cost: 0, known: true, source: "priced" })
    })

    it("keeps effectiveCostUsd as the numeric projection of the detailed form", () => {
      const r = row({ costUsd: 0, model: "test-model", outputTokens: 2_000_000 })
      expect(effectiveCostUsd(r, priceFor)).toBe(effectiveCostUsdDetailed(r, priceFor).cost)
    })
  })

  it("returns 0 when the model is missing", () => {
    expect(effectiveCostUsd(row({ costUsd: 0, model: undefined }), priceFor)).toBe(0)
  })

  it("uses row.providerId to resolve provider-catalog pricing", () => {
    const cost = effectiveCostUsd(
      row({
        costUsd: 0,
        model: "kimi-k2.6",
        providerId: "opencode-go",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    )
    expect(cost).toBeCloseTo(0.95 + 4, 6)
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
    expect(estimateCostFromTotals(totals, "test-model", undefined, priceFor)).toBeCloseTo(3 + 15, 6)
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
      undefined,
      priceFor
    )
    expect(cost).toBeCloseTo(3 * CACHE_READ_MULT + 3 * CACHE_WRITE_MULT, 6)
  })

  it("returns 0 for an unknown or missing model", () => {
    expect(estimateCostFromTotals(totals, "mystery", undefined, priceFor)).toBe(0)
    expect(estimateCostFromTotals(totals, undefined, undefined, priceFor)).toBe(0)
  })

  it("uses providerId to resolve provider-catalog pricing (real resolver)", () => {
    expect(estimateCostFromTotals(totals, "kimi-k2.6", "opencode-go")).toBeCloseTo(0.95 + 4, 6)
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

  it("sums cache-write (creation) tokens per model", () => {
    const rows = [
      row({ model: "test-model", costUsd: 1, cacheCreationTokens: 100 }),
      row({ model: "test-model", costUsd: 1, cacheCreationTokens: 50 }),
    ]
    const out = aggregateByModel(rows, priceFor)
    expect(out[0]!.cacheCreationTokens).toBe(150)
  })

  it("sums generation duration and reasoning tokens per model", () => {
    const rows = [
      row({ model: "test-model", costUsd: 1, durationMs: 2000, reasoningTokens: 40 }),
      row({ model: "test-model", costUsd: 1, durationMs: 3000, reasoningTokens: undefined }),
    ]
    const out = aggregateByModel(rows, priceFor)
    expect(out[0]!.durationMs).toBe(5000)
    // reasoningTokens is optional per row — undefined counts as 0.
    expect(out[0]!.reasoningTokens).toBe(40)
  })

  it("labels rows without a model as (unknown)", () => {
    const out = aggregateByModel([row({ model: undefined, costUsd: 1 })], priceFor)
    expect(out[0]!.model).toBe("(unknown)")
  })

  it("breaks cost ties by total tokens, then by model name", () => {
    const rows = [
      row({ model: "b-model", costUsd: 1, inputTokens: 10, outputTokens: 0 }),
      row({ model: "a-model", costUsd: 1, inputTokens: 10, outputTokens: 0 }),
      row({ model: "c-model", costUsd: 1, inputTokens: 50, outputTokens: 0 }),
    ]
    const out = aggregateByModel(rows, priceFor)
    // c has the most tokens → first; a sorts before b on the name tie-break.
    expect(out.map((m) => m.model)).toEqual(["c-model", "a-model", "b-model"])
  })
})

describe("localDay", () => {
  it("formats an epoch as a zero-padded LOCAL calendar day", () => {
    // Built from local parts so the assertion holds in any timezone — the
    // whole point of the helper is that it does not go through UTC.
    expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05")
    expect(localDay(new Date(2026, 11, 31, 0, 0).getTime())).toBe("2026-12-31")
  })
})

describe("parseLocalDay", () => {
  it("round-trips a localDay key back to that day's LOCAL midnight", () => {
    const key = localDay(new Date(2026, 4, 20, 17, 30).getTime())
    const parsed = parseLocalDay(key)
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(4)
    expect(parsed.getDate()).toBe(20)
    expect(parsed.getHours()).toBe(0)
  })

  it("falls back to the epoch's first day rather than an Invalid Date", () => {
    const parsed = parseLocalDay("not-a-day")
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    expect(parsed.getFullYear()).toBe(1970)
    expect(parsed.getMonth()).toBe(0)
    expect(parsed.getDate()).toBe(1)
  })
})

describe("topModelByTokens", () => {
  it("returns null for no rows", () => {
    expect(topModelByTokens([])).toBeNull()
  })

  it("ranks by token volume, not by cost", () => {
    // The cheap model moved far more tokens; a cost-ranked answer would
    // wrongly name the expensive one.
    const rows = [
      row({ messageId: "a", model: "haiku", inputTokens: 900_000, outputTokens: 100_000 }),
      row({ messageId: "b", model: "opus", inputTokens: 10, outputTokens: 10, costUsd: 99 }),
    ]
    expect(topModelByTokens(rows, priceFor)).toBe("haiku")
  })

  it("breaks ties deterministically by model name", () => {
    const rows = [
      row({ messageId: "a", model: "zeta", inputTokens: 10, outputTokens: 0 }),
      row({ messageId: "b", model: "alpha", inputTokens: 10, outputTokens: 0 }),
    ]
    expect(topModelByTokens(rows, priceFor)).toBe("alpha")
  })
})

describe("aggregateByDay", () => {
  it("buckets by local calendar day ascending", () => {
    // Local (not UTC) days: build the timestamps from local-time parts so the
    // assertion holds in any TZ the suite happens to run in.
    const day1 = new Date(2026, 4, 30, 23, 0, 0).getTime()
    const day2 = new Date(2026, 4, 31, 1, 0, 0).getTime()
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

  it("keeps a local-midnight turn on its own local day", () => {
    // 00:30 local — under the old UTC bucketing this landed on the previous or
    // next day for most of the world.
    const midnight = new Date(2026, 4, 31, 0, 30, 0).getTime()
    const out = aggregateByDay([row({ at: midnight, costUsd: 1 })], priceFor)
    expect(out.map((d) => d.date)).toEqual(["2026-05-31"])
  })

  it("emits only the days that carry usage", () => {
    const out = aggregateByDay(
      [
        row({ at: new Date(2026, 4, 20, 12).getTime(), costUsd: 1 }),
        row({ at: new Date(2026, 4, 25, 12).getTime(), costUsd: 1 }),
      ],
      priceFor
    )
    expect(out.map((d) => d.date)).toEqual(["2026-05-20", "2026-05-25"])
  })
})

describe("fillDailyRange", () => {
  const LOCAL_NOW = new Date(2026, 4, 31, 15, 0, 0).getTime()

  it("pads to exactly `days` cells, today inclusive, in ascending order", () => {
    const out = fillDailyRange([], 7, LOCAL_NOW)
    expect(out).toHaveLength(7)
    expect(out.map((d) => d.date)).toEqual([
      "2026-05-25",
      "2026-05-26",
      "2026-05-27",
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
      "2026-05-31",
    ])
    expect(out.every((d) => d.cost === 0 && d.tokens === 0 && d.requests === 0)).toBe(true)
  })

  it("keeps the aggregate for days that have usage", () => {
    const daily = aggregateByDay(
      [
        row({
          at: new Date(2026, 4, 30, 9).getTime(),
          costUsd: 4,
          inputTokens: 7,
          outputTokens: 0,
        }),
      ],
      priceFor
    )
    const out = fillDailyRange(daily, 7, LOCAL_NOW)
    const hit = out.find((d) => d.date === "2026-05-30")
    expect(hit).toEqual({ date: "2026-05-30", cost: 4, tokens: 7, requests: 1 })
  })

  it("drops days that fall outside the window", () => {
    const daily = [{ date: "2026-05-01", tokens: 1, cost: 1, requests: 1 }]
    const out = fillDailyRange(daily, 7, LOCAL_NOW)
    expect(out.some((d) => d.date === "2026-05-01")).toBe(false)
    expect(out.reduce((sum, d) => sum + d.cost, 0)).toBe(0)
  })

  it("returns exactly 30 and 90 cells for the wider ranges", () => {
    expect(fillDailyRange([], 30, LOCAL_NOW)).toHaveLength(30)
    const ninety = fillDailyRange([], 90, LOCAL_NOW)
    expect(ninety).toHaveLength(90)
    expect(ninety[0]!.date).toBe("2026-03-03")
    expect(ninety.at(-1)!.date).toBe("2026-05-31")
  })

  it("returns nothing for a non-positive or non-finite window", () => {
    expect(fillDailyRange([], 0, LOCAL_NOW)).toEqual([])
    expect(fillDailyRange([], -3, LOCAL_NOW)).toEqual([])
    expect(fillDailyRange([], Number.NaN, LOCAL_NOW)).toEqual([])
  })

  it("crosses a month boundary without gaps or duplicates", () => {
    const out = fillDailyRange([], 5, new Date(2026, 5, 2, 8).getTime())
    expect(out.map((d) => d.date)).toEqual([
      "2026-05-29",
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
    ])
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

  it("splits input and output tokens per session", () => {
    const out = aggregateBySession(
      [
        row({ sessionId: "a", costUsd: 1, inputTokens: 100, outputTokens: 20 }),
        row({ sessionId: "a", costUsd: 1, inputTokens: 50, outputTokens: 10 }),
      ],
      priceFor
    )
    expect(out[0]!.inputTokens).toBe(150)
    expect(out[0]!.outputTokens).toBe(30)
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

  it("cuts at local midnight with today counted as one day", () => {
    const now = new Date(2026, 4, 31, 15, 0, 0).getTime()
    // Day 7 of the window is 2026-05-25 — 00:00 is in, 23:59 the day before is out.
    const firstDay = row({ at: new Date(2026, 4, 25, 0, 0, 0).getTime() })
    const dayBefore = row({ at: new Date(2026, 4, 24, 23, 59, 59).getTime() })
    const out = filterByRange([dayBefore, firstDay], 7, now)
    expect(out).toEqual([firstDay])
  })

  it("keeps only today when the range is a single day", () => {
    const now = new Date(2026, 4, 31, 15, 0, 0).getTime()
    const today = row({ at: new Date(2026, 4, 31, 0, 0, 0).getTime() })
    const yesterday = row({ at: new Date(2026, 4, 30, 23, 0, 0).getTime() })
    expect(filterByRange([yesterday, today], 1, now)).toEqual([today])
  })
})

describe("analyzeUsageContributors", () => {
  it("returns no contributors for empty rows", () => {
    expect(analyzeUsageContributors([])).toEqual({ turns: 0, contributors: [] })
  })

  it("flags the high-context share from prompt tokens incl. cache", () => {
    const rows = [
      row({ inputTokens: HIGH_CONTEXT_THRESHOLD + 1 }),
      row({ inputTokens: 100, cacheReadTokens: HIGH_CONTEXT_THRESHOLD }),
      row({ inputTokens: 100 }),
    ]
    const out = analyzeUsageContributors(rows)
    const ctx = out.contributors.find((c) => c.id === "high-context")
    // 2 of 3 turns exceed the threshold → 67%.
    expect(ctx?.pct).toBe(67)
  })

  it("flags the automated-surface cost share, excluding chat", () => {
    const rows = [
      row({ surface: "chat", costUsd: 1 }),
      row({ surface: "agent-team", costUsd: 2 }),
      row({ surface: "workflow", costUsd: 1 }),
    ]
    const out = analyzeUsageContributors(rows)
    const auto = out.contributors.find((c) => c.id === "automated-surface")
    // 3 of 4 cost dollars came from non-chat surfaces → 75%.
    expect(auto?.pct).toBe(75)
  })

  it("omits a characteristic that does not apply and honors a custom threshold", () => {
    const rows = [row({ surface: "chat", costUsd: 1, inputTokens: 60_000 })]
    const out = analyzeUsageContributors(rows, { highContextThreshold: 50_000 })
    expect(out.contributors.map((c) => c.id)).toEqual(["high-context"])
    expect(out.contributors[0]!.pct).toBe(100)
  })
})

describe("export", () => {
  it("emits a header-only CSV for no rows", () => {
    expect(toUsageCsv([])).toBe(
      "messageId,sessionId,characterId,surface,at,model,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,reasoningTokens,contextInputTokens,costUsd,effectiveCostUsd,durationMs"
    )
  })

  it("escapes commas and quotes in CSV cells and defaults surface to chat", () => {
    const csv = toUsageCsv([row({ messageId: 'a,"b"', sessionId: "s", model: undefined })])
    const lines = csv.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"a,""b"""')
    // Legacy row without a surface exports as "chat" (characterId blank before it).
    expect(lines[1]).toContain(",chat,")
  })

  it("back-fills effectiveCostUsd for rows the SDK priced at $0", () => {
    // costUsd 0 + a priced model ⇒ raw column 0, effective column > 0.
    const csv = toUsageCsv(
      [row({ model: "test-model", costUsd: 0, inputTokens: 1_000_000, outputTokens: 0 })],
      priceFor
    )
    const cells = csv.split("\n")[1].split(",")
    expect(cells[12]).toBe("0") // costUsd (raw)
    expect(Number(cells[13])).toBeCloseTo(3) // effectiveCostUsd (1M input @ $3/1M)
  })

  it("carries the workflow surface through CSV", () => {
    const csv = toUsageCsv([row({ surface: "workflow" })])
    expect(csv.split("\n")[1].split(",")[3]).toBe("workflow")
  })

  it("augments JSON rows with surface + effectiveCostUsd", () => {
    const rows = [
      row({
        messageId: "x",
        model: "test-model",
        costUsd: 0,
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ]
    const parsed = JSON.parse(toUsageJson(rows, priceFor))
    expect(parsed[0]).toMatchObject({ messageId: "x", surface: "chat" })
    expect(parsed[0].effectiveCostUsd).toBeCloseTo(3)
  })

  it("date-stamps the filename", () => {
    expect(buildUsageFilename("csv", NOW)).toBe("cognia-usage-2026-05-31.csv")
    expect(buildUsageFilename("json", NOW)).toBe("cognia-usage-2026-05-31.json")
  })
})

describe("frozen cost is never re-priced (v172)", () => {
  it("returns a frozen sdk cost as stored, ignoring the current price table", () => {
    // The point of freezing: editing a price table must not rewrite history.
    const out = effectiveCostUsdDetailed(
      row({
        costUsd: 0.42,
        costSource: "sdk",
        costKnown: true,
        model: "test-model",
        inputTokens: 999_999_999,
      }),
      priceFor
    )
    expect(out).toEqual({ cost: 0.42, known: true, source: "sdk" })
  })

  it("returns a frozen locally-priced cost as stored", () => {
    const out = effectiveCostUsdDetailed(
      row({ costUsd: 1.75, costSource: "catalog", costKnown: true, model: "test-model" }),
      priceFor
    )
    expect(out).toEqual({ cost: 1.75, known: true, source: "priced" })
  })

  it("reports a frozen-unknown row as unknown even though the model is priceable now", () => {
    // A model we could not price at the time stays unknown; back-filling it at
    // today's rates would be inventing history.
    const out = effectiveCostUsdDetailed(
      row({ costUsd: 0, costSource: "unknown", costKnown: false, model: "test-model" }),
      priceFor
    )
    expect(out).toEqual({ cost: 0, known: false, source: "unknown" })
  })

  it("treats a backfilled legacy row as unknown", () => {
    const out = effectiveCostUsdDetailed(
      row({ costUsd: 0, costSource: "backfilled", costKnown: false, model: "test-model" }),
      priceFor
    )
    expect(out.known).toBe(false)
  })

  it("still prices a pre-v172 row that carries no provenance", () => {
    const out = effectiveCostUsdDetailed(
      row({
        costUsd: 0,
        model: "test-model",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
      priceFor
    )
    expect(out.source).toBe("priced")
    expect(out.cost).toBeCloseTo(3, 6)
  })

  it("prices a legacy row's 1-hour cache writes at the 2x rate", () => {
    const out = effectiveCostUsdDetailed(
      row({
        costUsd: 0,
        model: "test-model",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 1_000_000,
      }),
      priceFor
    )
    expect(out.cost).toBeCloseTo(3 * 2, 6)
  })
})
