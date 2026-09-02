/** @jest-environment jsdom */
// The conservation contract: `sessionUsage` is the money and
// `providerCostDaily` is a projection of it. Every test here asserts the two
// agree after a write sequence that used to make them disagree.

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { recordSurfaceUsage, upsertSessionUsage, USAGE_SURFACES } from "@/lib/db/session-usage"
import type { SessionUsageRow } from "@/lib/db/session-usage"

import {
  applyRollupDelta,
  commitUsageRow,
  contributesToBudget,
  freezeUsageCost,
  rebuildProviderCostDaily,
  setBudgetMirrorSink,
  type UsageCommitDaily,
} from "./usage-ledger"

const NOON = new Date(2026, 5, 5, 12, 0, 0).getTime()
const DAY_MS = 86_400_000

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

/** $1 per 1k input and $2 per 1k output, so the arithmetic stays readable. */
const flatPricing = () => ({ promptPer1M: 1000, completionPer1M: 2000 })

function row(over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "m1",
    sessionId: "s1",
    at: NOON,
    model: "test-model",
    providerId: "acme",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 100,
    ...over,
  }
}

async function dailyTotal(providerId = "acme"): Promise<number> {
  const rows = await getDb().providerCostDaily.toArray()
  return rows.filter((r) => r.providerId === providerId).reduce((sum, r) => sum + r.totalCostUsd, 0)
}

async function ledgerTotal(): Promise<number> {
  const rows = await getDb().sessionUsage.toArray()
  return rows
    .filter((r) => r.imported !== true && r.costKnown !== false)
    .reduce((sum, r) => sum + r.costUsd, 0)
}

describe("freezeUsageCost", () => {
  it("prices an unfrozen row once and marks it derived", () => {
    const frozen = freezeUsageCost(row({ costUsd: 0 }), flatPricing)
    expect(frozen.costSource).toBe("derived")
    expect(frozen.costKnown).toBe(true)
    expect(frozen.costUsd).toBeCloseTo(1000 * 1e-3 + 500 * 2e-3, 6)
  })

  it("keeps a provider-reported figure as sdk", () => {
    const frozen = freezeUsageCost(row({ costUsd: 4.2 }), flatPricing)
    expect(frozen.costSource).toBe("sdk")
    expect(frozen.costUsd).toBe(4.2)
  })

  it("never re-prices an already frozen row", () => {
    const already = row({ costUsd: 9, costSource: "sdk", costKnown: true })
    expect(freezeUsageCost(already, flatPricing)).toBe(already)
  })

  it("marks an unpriceable model unknown rather than free", () => {
    const frozen = freezeUsageCost(row({ costUsd: 0 }), () => null)
    expect(frozen.costKnown).toBe(false)
    expect(frozen.costSource).toBe("unknown")
    expect(frozen.costUsd).toBe(0)
  })
})

describe("contributesToBudget", () => {
  it("excludes imported spend", () => {
    expect(contributesToBudget(row({ imported: true }))).toBe(false)
  })

  it("excludes rows with no provider or no model", () => {
    expect(contributesToBudget(row({ providerId: undefined }))).toBe(false)
    expect(contributesToBudget(row({ model: undefined }))).toBe(false)
  })

  it("includes an ordinary local turn", () => {
    expect(contributesToBudget(row())).toBe(true)
  })

  it("treats every external-scan row as out of budget", () => {
    expect(contributesToBudget(row({ sourceId: "codex", imported: true }))).toBe(false)
  })
})

describe("commitUsageRow", () => {
  it("writes the ledger row and the projection in one go", async () => {
    const res = await commitUsageRow(row(), { resolve: flatPricing })
    expect(res?.replaced).toBe(false)
    expect(res?.daily?.providerTotalUsd).toBeCloseTo(2, 6)
    expect(await ledgerTotal()).toBeCloseTo(await dailyTotal(), 9)
  })

  it("applies a DELTA on overwrite instead of a second increment", async () => {
    await commitUsageRow(row(), { resolve: flatPricing })
    // Same messageId, twice the tokens: a retry that produced a bigger turn.
    const res = await commitUsageRow(row({ inputTokens: 2000, outputTokens: 1000 }), {
      resolve: flatPricing,
    })
    expect(res?.replaced).toBe(true)
    expect(await getDb().sessionUsage.count()).toBe(1)
    const bucket = await getDb().providerCostDaily.toArray()
    expect(bucket).toHaveLength(1)
    expect(bucket[0].requestCount).toBe(1)
    expect(bucket[0].totalCostUsd).toBeCloseTo(4, 6)
    expect(await ledgerTotal()).toBeCloseTo(await dailyTotal(), 9)
  })

  it("retracts the old bucket when a retry switches model", async () => {
    await commitUsageRow(row(), { resolve: flatPricing })
    await commitUsageRow(row({ model: "other-model" }), { resolve: flatPricing })
    const buckets = await getDb().providerCostDaily.toArray()
    // The first model's bucket emptied out and was removed, not left at 0.
    expect(buckets).toHaveLength(1)
    expect(buckets[0].modelId).toBe("other-model")
    expect(await ledgerTotal()).toBeCloseTo(await dailyTotal(), 9)
  })

  it("keeps imported rows out of the projection but in the ledger", async () => {
    await commitUsageRow(row({ messageId: "imported:1", imported: true }), {
      resolve: flatPricing,
    })
    expect(await getDb().sessionUsage.count()).toBe(1)
    expect(await getDb().providerCostDaily.count()).toBe(0)
  })

  it("does not project an unpriceable turn as free spend", async () => {
    await commitUsageRow(row(), { resolve: () => null })
    const buckets = await getDb().providerCostDaily.toArray()
    // Tokens still roll up (volume is real), but no money is claimed.
    expect(buckets[0].totalCostUsd).toBe(0)
    expect(buckets[0].inputTokens).toBe(1000)
  })

  it("reconciles the injected mirror sink to the committed total", async () => {
    const seen: UsageCommitDaily[] = []
    const dispose = setBudgetMirrorSink((c) => seen.push(c))
    try {
      await commitUsageRow(row(), { resolve: flatPricing })
      await commitUsageRow(row({ messageId: "m2" }), { resolve: flatPricing })
    } finally {
      dispose()
    }
    expect(seen.map((s) => s.providerTotalUsd)).toEqual([2, 4])
    expect(seen[1].deltaUsd).toBeCloseTo(2, 6)
  })

  it("survives a throwing mirror sink", async () => {
    const dispose = setBudgetMirrorSink(() => {
      throw new Error("mirror is down")
    })
    try {
      await expect(commitUsageRow(row(), { resolve: flatPricing })).resolves.not.toBeNull()
    } finally {
      dispose()
    }
    expect(await getDb().sessionUsage.count()).toBe(1)
  })

  it("refuses a row with no identity", async () => {
    expect(await commitUsageRow(row({ messageId: "" }))).toBeNull()
    expect(await commitUsageRow(row({ sessionId: "" }))).toBeNull()
  })
})

describe("conservation across every surface", () => {
  it.each(USAGE_SURFACES.filter((s) => s !== "imported"))(
    "keeps ledger and projection equal for the %s surface",
    async (surface) => {
      await recordSurfaceUsage({
        surface,
        operationId: `op-${surface}`,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          model: "test-model",
          providerId: "acme",
          costUsd: 1.5,
        },
        at: NOON,
      })
      // Written twice: a retried operation must not double the projection.
      await recordSurfaceUsage({
        surface,
        operationId: `op-${surface}`,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          model: "test-model",
          providerId: "acme",
          costUsd: 1.5,
        },
        at: NOON,
      })
      expect(await getDb().sessionUsage.count()).toBe(1)
      expect(await dailyTotal()).toBeCloseTo(1.5, 6)
      expect(await ledgerTotal()).toBeCloseTo(await dailyTotal(), 9)
    }
  )

  it("never lets an imported surface reach the projection", async () => {
    await recordSurfaceUsage({
      surface: "imported",
      operationId: "x",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        model: "test-model",
        providerId: "acme",
        costUsd: 99,
        imported: true,
      },
      at: NOON,
    })
    expect(await getDb().providerCostDaily.count()).toBe(0)
  })
})

describe("applyRollupDelta", () => {
  it("deletes a bucket a retraction empties instead of leaving a zero row", async () => {
    const db = getDb()
    const key = { day: "2026-06-05", providerId: "acme", modelId: "m" }
    await applyRollupDelta(
      db.providerCostDaily,
      key,
      { costUsd: 2, inputTokens: 10, outputTokens: 5, requestCount: 1 },
      NOON
    )
    await applyRollupDelta(
      db.providerCostDaily,
      key,
      { costUsd: -2, inputTokens: -10, outputTokens: -5, requestCount: -1 },
      NOON
    )
    expect(await db.providerCostDaily.count()).toBe(0)
  })

  it("clamps a bucket at zero rather than going negative", async () => {
    const db = getDb()
    const key = { day: "2026-06-05", providerId: "acme", modelId: "m" }
    await applyRollupDelta(
      db.providerCostDaily,
      key,
      { costUsd: -5, inputTokens: 1, outputTokens: 0, requestCount: 0 },
      NOON
    )
    const stored = await db.providerCostDaily.toArray()
    expect(stored[0].totalCostUsd).toBe(0)
  })
})

describe("rebuildProviderCostDaily", () => {
  it("converges a projection that drifted", async () => {
    await commitUsageRow(row(), { resolve: flatPricing })
    // Simulate the pre-ADR-0165 drift: a second, parallel increment.
    const db = getDb()
    const [bucket] = await db.providerCostDaily.toArray()
    await db.providerCostDaily.put({ ...bucket, totalCostUsd: bucket.totalCostUsd * 3 })
    expect(await dailyTotal()).toBeCloseTo(6, 6)

    const result = await rebuildProviderCostDaily(90, { now: NOON, resolve: flatPricing })
    expect(result.rows).toBe(1)
    expect(await dailyTotal()).toBeCloseTo(2, 6)
    expect(await ledgerTotal()).toBeCloseTo(await dailyTotal(), 9)
  })

  it("drops buckets whose ledger rows are gone", async () => {
    await commitUsageRow(row(), { resolve: flatPricing })
    await getDb().sessionUsage.clear()
    await rebuildProviderCostDaily(90, { now: NOON, resolve: flatPricing })
    expect(await getDb().providerCostDaily.count()).toBe(0)
  })

  it("leaves buckets outside the window alone", async () => {
    const db = getDb()
    await db.providerCostDaily.put({
      id: "2000-01-01|acme|old",
      day: "2000-01-01",
      providerId: "acme",
      modelId: "old",
      totalCostUsd: 7,
      requestCount: 1,
      updatedAt: 0,
    })
    await rebuildProviderCostDaily(7, { now: NOON, resolve: flatPricing })
    expect(await db.providerCostDaily.get("2000-01-01|acme|old")).toBeDefined()
  })

  it("excludes imported rows from the rebuilt projection", async () => {
    await upsertSessionUsage(
      freezeUsageCost(row({ messageId: "i1", imported: true, costUsd: 5 }), flatPricing)
    )
    await upsertSessionUsage(freezeUsageCost(row({ at: NOON - DAY_MS }), flatPricing))
    await rebuildProviderCostDaily(90, { now: NOON, resolve: flatPricing })
    expect(await dailyTotal()).toBeCloseTo(2, 6)
  })
})
