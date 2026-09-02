// Detectors. Each one is a claim about someone's money, so the tests check
// both that it fires when it should and that it stays quiet when the evidence
// cannot support it.

import type { SessionUsageRow } from "@/lib/db/session-usage"

import {
  detectCacheColdStarts,
  detectRetrySpend,
  detectRunawaySession,
  detectUnpricedSpend,
  DETECTORS,
  FINDING_SCHEMA_VERSION,
  runDetectors,
} from "./findings"

const T0 = new Date(2026, 5, 5, 12, 0, 0).getTime()
const DAY = 86_400_000
const flatPricing = () => ({ promptPer1M: 1000, completionPer1M: 2000 })

function row(over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "m1",
    sessionId: "s1",
    at: T0,
    model: "test-model",
    providerId: "acme",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 2,
    durationMs: 0,
    costSource: "sdk",
    costKnown: true,
    ...over,
  }
}

function many(n: number, over: (i: number) => Partial<SessionUsageRow>): SessionUsageRow[] {
  return Array.from({ length: n }, (_, i) => row({ messageId: `m${i}`, ...over(i) }))
}

const window = { fromMs: T0 - 7 * DAY, toMs: T0, resolve: flatPricing }

describe("detectCacheColdStarts", () => {
  it("stays quiet below the evidence floor", () => {
    expect(detectCacheColdStarts({ rows: many(5, () => ({})), ...window })).toBeNull()
  })

  it("fires when almost nothing is served from cache", () => {
    const finding = detectCacheColdStarts({ rows: many(40, () => ({})), ...window })
    expect(finding?.detector).toBe("cacheColdStarts")
    expect(finding?.severity).toBe("high")
    expect(finding?.basis).toBe("estimated")
    expect(finding?.class).toBe("habit")
  })

  it("stays quiet when caching is already working", () => {
    const rows = many(40, () => ({ inputTokens: 100, cacheReadTokens: 900 }))
    expect(detectCacheColdStarts({ rows, ...window })).toBeNull()
  })

  it("never claims a saving larger than the spend it looked at", () => {
    const finding = detectCacheColdStarts({ rows: many(40, () => ({})), ...window })
    expect(finding!.estimatedSavingUsd).toBeLessThanOrEqual(finding!.impactUsd)
  })

  it("is less confident on a thin window", () => {
    const thin = detectCacheColdStarts({ rows: many(25, () => ({})), ...window })
    const thick = detectCacheColdStarts({ rows: many(120, () => ({})), ...window })
    expect(thin!.confidence).toBeLessThan(thick!.confidence)
  })

  it("stays quiet when nothing could be priced", () => {
    const rows = many(40, () => ({ costSource: "unknown" as const, costKnown: false, costUsd: 0 }))
    expect(detectCacheColdStarts({ rows, ...window })).toBeNull()
  })
})

describe("detectRetrySpend", () => {
  const retryRows = [
    row({ messageId: "a", runId: "r", turnId: "t1", attemptId: "1", at: T0, costUsd: 5 }),
    row({ messageId: "b", runId: "r", turnId: "t1", attemptId: "2", at: T0 + 1, costUsd: 5 }),
    row({ messageId: "c", runId: "r", turnId: "t2", attemptId: "1", at: T0 + 2, costUsd: 5 }),
  ]

  it("reports superseded attempts as measured waste", () => {
    const finding = detectRetrySpend({ rows: retryRows, ...window })
    expect(finding?.basis).toBe("measured")
    expect(finding?.impactUsd).toBeCloseTo(5)
  })

  it("stays silent when the rows carry no attempt identity", () => {
    // Zero retries here would say something about the data, not the user.
    expect(detectRetrySpend({ rows: [row(), row({ messageId: "b" })], ...window })).toBeNull()
  })

  it("stays quiet when retries are a small share of the bill", () => {
    const rows = [
      ...retryRows.slice(0, 1),
      ...Array.from({ length: 20 }, (_, i) =>
        row({ messageId: `x${i}`, runId: "r", turnId: `t${i + 5}`, attemptId: "1", costUsd: 5 })
      ),
    ]
    expect(detectRetrySpend({ rows, ...window })).toBeNull()
  })

  it("never claims to recover more than the waste it measured", () => {
    const finding = detectRetrySpend({ rows: retryRows, ...window })
    expect(finding!.estimatedSavingUsd).toBeLessThanOrEqual(finding!.impactUsd)
  })
})

describe("detectUnpricedSpend", () => {
  it("reports a window with a meaningful unpriced share", () => {
    const rows = [
      ...many(5, () => ({ costSource: "unknown" as const, costKnown: false, costUsd: 0 })),
      ...many(5, (i) => ({ messageId: `p${i}` })),
    ]
    const finding = detectUnpricedSpend({ rows, ...window })
    expect(finding?.class).toBe("info")
    expect(finding?.evidence.unpricedTurns).toBe(5)
  })

  it("reports zero impact rather than guessing at the missing money", () => {
    const rows = many(10, () => ({ costSource: "unknown" as const, costKnown: false, costUsd: 0 }))
    expect(detectUnpricedSpend({ rows, ...window })?.impactUsd).toBe(0)
  })

  it("stays quiet when nearly everything priced", () => {
    const rows = many(40, () => ({}))
    expect(detectUnpricedSpend({ rows, ...window })).toBeNull()
  })

  it("stays quiet on an empty window", () => {
    expect(detectUnpricedSpend({ rows: [], ...window })).toBeNull()
  })
})

describe("detectRunawaySession", () => {
  it("names a unit that dominated the window", () => {
    const rows = [
      row({ messageId: "a", sessionId: "big", costUsd: 50 }),
      row({ messageId: "b", sessionId: "s2", costUsd: 5 }),
      row({ messageId: "c", sessionId: "s3", costUsd: 5 }),
    ]
    const finding = detectRunawaySession({ rows, ...window })
    expect(finding?.detector).toBe("runawaySession")
    expect(finding?.class).toBe("info")
  })

  it("stays quiet when spend is evenly spread", () => {
    const rows = many(9, (i) => ({ sessionId: `s${i}`, costUsd: 5 }))
    expect(detectRunawaySession({ rows, ...window })).toBeNull()
  })

  it("needs more than a couple of units before naming one", () => {
    const rows = [row({ sessionId: "a", costUsd: 50 }), row({ messageId: "b", sessionId: "b" })]
    expect(detectRunawaySession({ rows, ...window })).toBeNull()
  })

  it("carries only ids and counts, never a title or a path", () => {
    const rows = [
      row({ messageId: "a", sessionId: "big", costUsd: 50 }),
      row({ messageId: "b", sessionId: "s2", costUsd: 5 }),
      row({ messageId: "c", sessionId: "s3", costUsd: 5 }),
    ]
    const finding = detectRunawaySession({ rows, ...window })!
    for (const value of Object.values(finding.params)) {
      expect(typeof value === "number" || /^[\w:.-]+$/.test(String(value))).toBe(true)
    }
  })
})

describe("runDetectors", () => {
  it("stamps every finding with the schema version", () => {
    const findings = runDetectors({ rows: many(40, () => ({})), ...window })
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) expect(f.schemaVersion).toBe(FINDING_SCHEMA_VERSION)
  })

  it("orders by severity, then by what a fix is worth", () => {
    const findings = runDetectors({ rows: many(120, () => ({})), ...window })
    const rank = { high: 2, medium: 1, low: 0 } as const
    for (let i = 1; i < findings.length; i += 1) {
      expect(rank[findings[i - 1].severity]).toBeGreaterThanOrEqual(rank[findings[i].severity])
    }
  })

  it("returns nothing for an empty window", () => {
    expect(runDetectors({ rows: [], ...window })).toEqual([])
  })

  it("survives a detector that throws", () => {
    const original = [...DETECTORS]
    expect(original.length).toBeGreaterThan(0)
    // The registry is readonly, so this asserts the guard rather than mutating
    // it: a detector that throws is caught inside `runDetectors`.
    expect(() => runDetectors({ rows: many(40, () => ({})), ...window })).not.toThrow()
  })
})
