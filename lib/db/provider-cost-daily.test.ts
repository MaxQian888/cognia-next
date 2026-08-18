// Coverage for the providerCostDaily rollup module — id/day helpers, atomic
// upsert-increment, today aggregation, range query, and pruning. Uses
// fake-indexeddb so the real Dexie query path runs against in-memory IDB.

import {
  buildCostDailyId,
  getCostRange,
  getLastUsedByProvider,
  getTodaysCostByProvider,
  incrementProviderCost,
  localDayString,
  pruneProviderCostOlderThan,
} from "./provider-cost-daily"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const DAY_MS = 86_400_000

// A fixed reference instant: 2026-06-05T12:00 local time.
const NOON = new Date(2026, 5, 5, 12, 0, 0).getTime()

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("localDayString", () => {
  it("formats the local day as YYYY-MM-DD with zero padding", () => {
    expect(localDayString(new Date(2026, 0, 3, 9, 30).getTime())).toBe("2026-01-03")
  })

  it("rolls to the next day across local midnight", () => {
    const beforeMidnight = new Date(2026, 5, 5, 23, 59, 59).getTime()
    const afterMidnight = new Date(2026, 5, 6, 0, 0, 1).getTime()
    expect(localDayString(beforeMidnight)).toBe("2026-06-05")
    expect(localDayString(afterMidnight)).toBe("2026-06-06")
  })
})

describe("buildCostDailyId", () => {
  it("joins day, provider, and model with pipes", () => {
    expect(buildCostDailyId("2026-06-05", "openai", "gpt-4o")).toBe("2026-06-05|openai|gpt-4o")
  })
})

describe("incrementProviderCost", () => {
  it("creates a row on first increment and sums on subsequent ones", async () => {
    await incrementProviderCost({
      providerId: "openai",
      modelId: "gpt-4o",
      costUsd: 0.5,
      now: NOON,
    })
    await incrementProviderCost({
      providerId: "openai",
      modelId: "gpt-4o",
      costUsd: 0.25,
      now: NOON + 1000,
    })

    const id = buildCostDailyId(localDayString(NOON), "openai", "gpt-4o")
    const row = await getDb().providerCostDaily.get(id)
    expect(row).toBeTruthy()
    expect(row?.totalCostUsd).toBeCloseTo(0.75)
    expect(row?.requestCount).toBe(2)
    expect(row?.updatedAt).toBe(NOON + 1000)
  })

  it("keeps separate rows per model and per day", async () => {
    await incrementProviderCost({ providerId: "openai", modelId: "gpt-4o", costUsd: 1, now: NOON })
    await incrementProviderCost({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      costUsd: 2,
      now: NOON,
    })
    await incrementProviderCost({
      providerId: "openai",
      modelId: "gpt-4o",
      costUsd: 4,
      now: NOON + DAY_MS,
    })

    const rows = await getDb().providerCostDaily.toArray()
    expect(rows).toHaveLength(3)
  })

  it("sums token volume into the bucket and accepts zero-cost turns that carry tokens", async () => {
    await incrementProviderCost({
      providerId: "ollama",
      modelId: "llama3",
      costUsd: 0,
      inputTokens: 100,
      outputTokens: 20,
      now: NOON,
    })
    await incrementProviderCost({
      providerId: "ollama",
      modelId: "llama3",
      costUsd: 0,
      inputTokens: 50,
      outputTokens: 5,
      now: NOON,
    })
    const row = await getDb().providerCostDaily.get(
      buildCostDailyId("2026-06-05", "ollama", "llama3")
    )
    expect(row).toMatchObject({
      requestCount: 2,
      totalCostUsd: 0,
      inputTokens: 150,
      outputTokens: 25,
    })
    // A bare zero-cost turn with no tokens is still the legacy no-op.
    await incrementProviderCost({ providerId: "ollama", modelId: "empty", costUsd: 0, now: NOON })
    expect(
      await getDb().providerCostDaily.get(buildCostDailyId("2026-06-05", "ollama", "empty"))
    ).toBeUndefined()
  })

  it("ignores invalid input (missing ids, non-positive or non-finite cost)", async () => {
    await incrementProviderCost({ providerId: "", modelId: "m", costUsd: 1, now: NOON })
    await incrementProviderCost({ providerId: "p", modelId: "", costUsd: 1, now: NOON })
    await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: 0, now: NOON })
    await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: -1, now: NOON })
    await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: Number.NaN, now: NOON })

    expect(await getDb().providerCostDaily.count()).toBe(0)
  })

  it("never loses updates under concurrent increments (rw transaction)", async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        incrementProviderCost({ providerId: "openai", modelId: "gpt-4o", costUsd: 0.1, now: NOON })
      )
    )
    const id = buildCostDailyId(localDayString(NOON), "openai", "gpt-4o")
    const row = await getDb().providerCostDaily.get(id)
    expect(row?.requestCount).toBe(10)
    expect(row?.totalCostUsd).toBeCloseTo(1.0)
  })
})

describe("getTodaysCostByProvider", () => {
  it("sums across models for today and ignores other days", async () => {
    await incrementProviderCost({ providerId: "openai", modelId: "gpt-4o", costUsd: 1, now: NOON })
    await incrementProviderCost({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      costUsd: 0.5,
      now: NOON,
    })
    await incrementProviderCost({
      providerId: "anthropic",
      modelId: "claude",
      costUsd: 2,
      now: NOON,
    })
    await incrementProviderCost({
      providerId: "openai",
      modelId: "gpt-4o",
      costUsd: 99,
      now: NOON - DAY_MS,
    })

    const totals = await getTodaysCostByProvider(NOON)
    expect(totals).toEqual({ openai: 1.5, anthropic: 2 })
  })

  it("returns an empty record when nothing was spent today", async () => {
    expect(await getTodaysCostByProvider(NOON)).toEqual({})
  })
})

describe("getCostRange", () => {
  it("returns rows within the inclusive day range", async () => {
    await incrementProviderCost({
      providerId: "p",
      modelId: "m",
      costUsd: 1,
      now: NOON - 2 * DAY_MS,
    })
    await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: 2, now: NOON - DAY_MS })
    await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: 4, now: NOON })

    const rows = await getCostRange(localDayString(NOON - DAY_MS), localDayString(NOON))
    expect(rows.map((r) => r.totalCostUsd).sort()).toEqual([2, 4])
  })
})

describe("getLastUsedByProvider", () => {
  it("returns the newest updatedAt per provider across days and models", async () => {
    await incrementProviderCost({ providerId: "openai", modelId: "a", costUsd: 1, now: NOON })
    await incrementProviderCost({
      providerId: "openai",
      modelId: "b",
      costUsd: 1,
      now: NOON + 3 * DAY_MS,
    })
    await incrementProviderCost({
      providerId: "anthropic",
      modelId: "c",
      costUsd: 1,
      now: NOON + DAY_MS,
    })
    const rows = await getDb().providerCostDaily.toArray()
    const expectedOpenAi = Math.max(
      ...rows.filter((r) => r.providerId === "openai").map((r) => r.updatedAt)
    )
    const expectedAnthropic = rows.find((r) => r.providerId === "anthropic")!.updatedAt
    expect(await getLastUsedByProvider()).toEqual({
      openai: expectedOpenAi,
      anthropic: expectedAnthropic,
    })
  })

  it("returns an empty record for an empty table", async () => {
    expect(await getLastUsedByProvider()).toEqual({})
  })
})

describe("pruneProviderCostOlderThan", () => {
  it("drops rows older than the cutoff and keeps newer ones", async () => {
    await incrementProviderCost({
      providerId: "p",
      modelId: "m",
      costUsd: 1,
      now: NOON - 100 * DAY_MS,
    })
    await incrementProviderCost({
      providerId: "p",
      modelId: "m",
      costUsd: 2,
      now: NOON - 10 * DAY_MS,
    })
    await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: 4, now: NOON })

    const removed = await pruneProviderCostOlderThan(90, NOON)
    expect(removed).toBe(1)
    const remaining = await getDb().providerCostDaily.toArray()
    expect(remaining).toHaveLength(2)
  })

  it("treats days <= 0 or non-finite as never-prune", async () => {
    await incrementProviderCost({
      providerId: "p",
      modelId: "m",
      costUsd: 1,
      now: NOON - 100 * DAY_MS,
    })
    expect(await pruneProviderCostOlderThan(0, NOON)).toBe(0)
    expect(await pruneProviderCostOlderThan(-5, NOON)).toBe(0)
    expect(await pruneProviderCostOlderThan(Number.NaN, NOON)).toBe(0)
    expect(await getDb().providerCostDaily.count()).toBe(1)
  })

  it("returns 0 when nothing is stale", async () => {
    await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: 1, now: NOON })
    expect(await pruneProviderCostOlderThan(90, NOON)).toBe(0)
  })
})

describe("incrementProviderCost return value", () => {
  it("returns the provider's committed day total summed across models", async () => {
    const now = new Date(2026, 5, 5, 12, 0, 0).getTime()
    const first = await incrementProviderCost({
      providerId: "openai",
      modelId: "gpt-5",
      costUsd: 0.25,
      now,
    })
    expect(first).toEqual({
      day: localDayString(now),
      providerId: "openai",
      providerTotalUsd: 0.25,
    })

    // A second model for the same provider rolls into the same provider total.
    const second = await incrementProviderCost({
      providerId: "openai",
      modelId: "gpt-5-mini",
      costUsd: 0.75,
      now,
    })
    expect(second?.providerTotalUsd).toBeCloseTo(1.0, 6)

    // Another provider does not contaminate it.
    const other = await incrementProviderCost({
      providerId: "anthropic",
      modelId: "claude-opus-5",
      costUsd: 4,
      now,
    })
    expect(other?.providerTotalUsd).toBeCloseTo(4, 6)
    expect(other?.providerId).toBe("anthropic")
  })

  it("returns null for input the writer rejects", async () => {
    expect(await incrementProviderCost({ providerId: "", modelId: "m", costUsd: 1 })).toBeNull()
    expect(await incrementProviderCost({ providerId: "p", modelId: "", costUsd: 1 })).toBeNull()
    expect(
      await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: Number.NaN })
    ).toBeNull()
    expect(await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: -1 })).toBeNull()
    // Zero cost with no tokens stays the legacy no-op.
    expect(await incrementProviderCost({ providerId: "p", modelId: "m", costUsd: 0 })).toBeNull()
  })

  it("returns a total for a zero-cost turn that carried tokens", async () => {
    const now = new Date(2026, 5, 5, 12, 0, 0).getTime()
    const res = await incrementProviderCost({
      providerId: "ollama",
      modelId: "llama-3",
      costUsd: 0,
      inputTokens: 1200,
      now,
    })
    expect(res).not.toBeNull()
    expect(res?.providerTotalUsd).toBe(0)
  })
})
