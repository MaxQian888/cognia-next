/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { completeBotRunStep } from "@/lib/db/bot-run-steps"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

import {
  BotRunBudgetExceededError,
  getBotInvocationCost,
  priceBotInvocation,
  recordBotInvocationCost,
  remainingBotRunBudgetUsd,
  summarizeBotRunCost,
  tokenAllowanceForUsd,
} from "./run-cost"

const catalog = (_provider: string, model: string) =>
  model === "priced-model"
    ? { promptPer1M: 2, completionPer1M: 10, cachedInputPer1M: 0.2 }
    : undefined

beforeEach(async () => {
  __resetDbForTesting()
  await getDb().botRunSteps.clear()
})

describe("priceBotInvocation", () => {
  it("prefers a provider-reported USD figure", () => {
    expect(
      priceBotInvocation(
        {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          providerCost: { amount: 0.5, currency: "usd" },
        },
        { providerId: "p", modelId: "priced-model" },
        { catalog }
      )
    ).toMatchObject({ costUsd: 0.5, source: "provider" })
  })

  it("never reads a provider figure with no currency as dollars", () => {
    expect(
      priceBotInvocation(
        {
          promptTokens: 1_000_000,
          completionTokens: 0,
          totalTokens: 1_000_000,
          providerCost: { amount: 99 },
        },
        { providerId: "p", modelId: "priced-model" },
        { catalog }
      )
    ).toMatchObject({ costUsd: 2, source: "pricing" })
  })

  it("prices tokens including cache reads from the shared table", () => {
    const cost = priceBotInvocation(
      {
        promptTokens: 1_000_000,
        completionTokens: 100_000,
        totalTokens: 1_100_000,
        cacheReadTokens: 1_000_000,
      },
      { providerId: "p", modelId: "priced-model" },
      { catalog }
    )
    expect(cost.source).toBe("pricing")
    expect(cost.costUsd).toBeCloseTo(2 + 1 + 0.2)
  })

  it("reports an unknown price as unknown, never as free", () => {
    expect(
      priceBotInvocation(
        { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        { providerId: "p", modelId: "mystery-model" },
        { catalog }
      )
    ).toMatchObject({ costUsd: null, source: "unknown" })
  })
})

describe("tokenAllowanceForUsd", () => {
  it("buys tokens at the most expensive rate, rounded down", () => {
    expect(tokenAllowanceForUsd(1, { providerId: "p", modelId: "priced-model" }, { catalog })).toBe(
      100_000
    )
  })

  it("has no allowance for an unpriced model", () => {
    expect(
      tokenAllowanceForUsd(1, { providerId: "p", modelId: "mystery-model" }, { catalog })
    ).toBeUndefined()
  })
})

describe("run ledger", () => {
  const cost = (costUsd: number | null) => ({
    costUsd,
    source: costUsd === null ? ("unknown" as const) : ("pricing" as const),
    inputTokens: 1,
    outputTokens: 1,
  })

  it("sums one immutable entry per invocation, so a replay never charges twice", async () => {
    await recordBotInvocationCost("run_1", "__host:external-agent", cost(0.4))
    await recordBotInvocationCost("run_1", "__host:external-agent", cost(9))
    await recordBotInvocationCost("run_1", "__host:external-agent:fix-1", cost(0.3))
    await recordBotInvocationCost("run_1", "__host:external-agent:fix-2", cost(null))
    // Another run's spend and unrelated steps are not this run's.
    await recordBotInvocationCost("run_2", "__host:external-agent", cost(5))
    await completeBotRunStep("run_1", "collect-context", { bytes: 10 })

    expect(await getBotInvocationCost("run_1", "__host:external-agent")).toMatchObject({
      costUsd: 0.4,
    })
    const summary = await summarizeBotRunCost("run_1")
    expect(summary.spentUsd).toBeCloseTo(0.7)
    expect(summary).toMatchObject({ unpricedInvocations: 1, invocations: 3 })
  })

  it("leaves an uncapped run uncapped and refuses a spent one", async () => {
    await expect(remainingBotRunBudgetUsd("run_1", undefined)).resolves.toBeUndefined()
    await recordBotInvocationCost("run_1", "a", cost(1.5))
    await expect(remainingBotRunBudgetUsd("run_1", 2)).resolves.toBeCloseTo(0.5)
    await recordBotInvocationCost("run_1", "b", cost(0.5))
    await expect(remainingBotRunBudgetUsd("run_1", 2)).rejects.toBeInstanceOf(
      BotRunBudgetExceededError
    )
  })
})
