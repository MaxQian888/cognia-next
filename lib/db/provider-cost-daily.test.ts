/** @jest-environment jsdom */
// Coverage for the providerCostDaily rollup module — id/day helpers, atomic
// upsert-increment, today aggregation, range query, and pruning. Uses
// fake-indexeddb so the real Dexie query path runs against in-memory IDB.

import "fake-indexeddb/auto"
import {
  buildCostDailyId,
  getCostRange,
  getTodaysCostByProvider,
  incrementProviderCost,
  localDayString,
  pruneProviderCostOlderThan,
} from "./provider-cost-daily"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

const DAY_MS = 86_400_000

// A fixed reference instant: 2026-06-05T12:00 local time.
const NOON = new Date(2026, 5, 5, 12, 0, 0).getTime()

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

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
