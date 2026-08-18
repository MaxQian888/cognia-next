import { createRunBudgetGovernor } from "./run-budget-governor"
import type { TeamNotifier } from "@/lib/ai/agent/team/team-notifier"

function makeNotifier(): TeamNotifier {
  return { notify: jest.fn(), suspend: jest.fn(), resume: jest.fn() } as unknown as TeamNotifier
}

function makeGovernor(limit = 1_000) {
  return createRunBudgetGovernor({
    runId: "root-run",
    limit,
    onCritical: "notify",
    notifier: makeNotifier(),
  })
}

describe("createRunBudgetGovernor", () => {
  it("draws every child's usage down the SAME root guard", () => {
    const governor = makeGovernor(1_000)
    const a = governor.allocate("child-a")
    const b = governor.allocate("child-b")
    a.add({ promptTokens: 100, completionTokens: 100, totalTokens: 200 })
    b.add({ promptTokens: 50, completionTokens: 50, totalTokens: 100 })

    expect(governor.totals().usedTokens).toBe(300)
    expect(governor.children()).toEqual([
      expect.objectContaining({ childRunId: "child-a", usedTokens: 200 }),
      expect.objectContaining({ childRunId: "child-b", usedTokens: 100 }),
    ])
  })

  it("counts attempts, provider attempts and failures per child and in totals", () => {
    const governor = makeGovernor()
    const a = governor.allocate("child-a")
    const b = governor.allocate("child-b")
    a.recordAttempt()
    a.recordProviderAttempt()
    a.recordProviderAttempt()
    a.recordFailure()
    b.recordAttempt()

    expect(governor.children()).toEqual([
      expect.objectContaining({ attempts: 1, providerAttempts: 2, failures: 1 }),
      expect.objectContaining({ attempts: 1, providerAttempts: 0, failures: 0 }),
    ])
    expect(governor.totals()).toMatchObject({ attempts: 2, providerAttempts: 2, failures: 1 })
  })

  it("re-allocating the same child id reopens the SAME ledger (idempotent)", () => {
    const governor = makeGovernor()
    governor.allocate("child-a").add({ promptTokens: 0, completionTokens: 0, totalTokens: 100 })
    governor.allocate("child-a").add({ promptTokens: 0, completionTokens: 0, totalTokens: 50 })
    expect(governor.children()).toHaveLength(1)
    expect(governor.children()[0].usedTokens).toBe(150)
  })

  it("children observe root exhaustion (critical level) and the guard escalates once", () => {
    const notifier = makeNotifier()
    const governor = createRunBudgetGovernor({
      runId: "root-run",
      limit: 100,
      onCritical: "notify",
      notifier,
    })
    const a = governor.allocate("child-a")
    expect(a.isExhausted()).toBe(false)
    a.add({ promptTokens: 0, completionTokens: 0, totalTokens: 96 })
    expect(a.isExhausted()).toBe(true)
    // A sibling allocated later sees the same root state.
    expect(governor.allocate("child-b").isExhausted()).toBe(true)
    expect(governor.totals().level).toBe("critical")
  })

  it("a HITL extendLimit on the root guard un-exhausts every child", () => {
    const governor = makeGovernor(100)
    const a = governor.allocate("child-a")
    a.add({ promptTokens: 0, completionTokens: 0, totalTokens: 100 })
    expect(a.isExhausted()).toBe(true)
    governor.guard.extendLimit(1_000)
    expect(a.isExhausted()).toBe(false)
  })

  it("tolerates usage rows without totalTokens (prompt+completion fallback)", () => {
    const governor = makeGovernor()
    governor
      .allocate("child-a")
      .add({ promptTokens: 30, completionTokens: 20 } as unknown as Parameters<
        ReturnType<typeof makeGovernor>["guard"]["add"]
      >[0])
    expect(governor.totals().usedTokens).toBe(50)
    // A fully-empty usage row contributes zero (all ?? 0 fallbacks).
    governor
      .allocate("child-a")
      .add({} as unknown as Parameters<ReturnType<typeof makeGovernor>["guard"]["add"]>[0])
    expect(governor.totals().usedTokens).toBe(50)
  })
})

describe("cost budget controller", () => {
  function costGovernor(
    costPolicy: Parameters<typeof createRunBudgetGovernor>[0]["costPolicy"],
    costSpend?: Parameters<typeof createRunBudgetGovernor>[0]["costSpend"]
  ) {
    const onCostThreshold = jest.fn()
    const governor = createRunBudgetGovernor({
      runId: "root-run",
      limit: 0,
      onCritical: "notify",
      notifier: makeNotifier(),
      costPolicy,
      costSpend,
      onCostThreshold,
    })
    return { governor, onCostThreshold }
  }

  it("allows everything when no USD ceiling is configured", () => {
    const { governor } = costGovernor(undefined)
    governor.cost.add({ costUsd: 10_000 })
    expect(governor.cost.check()).toEqual({ allowed: true, verdict: null })
  })

  it("accumulates spend across the day and month windows at once", () => {
    const { governor } = costGovernor({ dailyUsd: 10, monthlyUsd: 100 })
    governor.cost.add({ costUsd: 4, providerId: "anthropic" })
    governor.cost.add({ costUsd: 1, providerId: "openai" })
    const byKey = new Map(governor.cost.verdicts().map((v) => [v.scopeKey, v]))
    expect(byKey.get("day:*")?.usedUsd).toBe(5)
    expect(byKey.get("month:*")?.usedUsd).toBe(5)
  })

  it("attributes spend to the provider that incurred it", () => {
    const { governor } = costGovernor({ perProviderDailyUsd: { anthropic: 10, openai: 10 } })
    governor.cost.add({ costUsd: 9, providerId: "anthropic" })
    expect(governor.cost.worst("anthropic")?.usedUsd).toBe(9)
    expect(governor.cost.worst("openai")?.usedUsd).toBe(0)
  })

  it("fires each threshold once per scope, at the level actually reached", () => {
    const { governor, onCostThreshold } = costGovernor({ dailyUsd: 100 })
    governor.cost.add({ costUsd: 80 })
    governor.cost.add({ costUsd: 1 })
    expect(onCostThreshold).toHaveBeenCalledTimes(1)
    expect(onCostThreshold.mock.calls[0][0]).toMatchObject({ level: "warning" })

    // A single expensive turn may jump straight past `critical` to `exceeded`;
    // reporting the level reached beats replaying every step.
    governor.cost.add({ costUsd: 50 })
    expect(onCostThreshold).toHaveBeenCalledTimes(2)
    expect(onCostThreshold.mock.calls[1][0]).toMatchObject({ level: "exceeded" })
  })

  it("never announces an ok scope", () => {
    const { governor, onCostThreshold } = costGovernor({ dailyUsd: 100 })
    governor.cost.add({ costUsd: 1 })
    expect(onCostThreshold).not.toHaveBeenCalled()
  })

  it("hard-blocks at the ceiling", () => {
    const { governor } = costGovernor({ dailyUsd: 10 })
    governor.cost.add({ costUsd: 9.99 })
    expect(governor.cost.check().allowed).toBe(true)
    governor.cost.add({ costUsd: 0.01 })
    const decision = governor.cost.check()
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.blockedBy.map((v) => v.scopeKey)).toEqual([
      "day:*",
    ])
  })

  it("consumes a one-shot override — the next send blocks again", () => {
    const { governor } = costGovernor({ dailyUsd: 10 })
    governor.cost.add({ costUsd: 12 })
    expect(governor.cost.check().allowed).toBe(false)

    governor.cost.grantOverride("day:*")
    expect(governor.cost.pendingOverrides()).toEqual(["day:*"])
    expect(governor.cost.check().allowed).toBe(true)
    // An override that persisted would silently turn the ceiling off.
    expect(governor.cost.pendingOverrides()).toEqual([])
    expect(governor.cost.check().allowed).toBe(false)
  })

  it("requires an override for EVERY blocking scope", () => {
    const { governor } = costGovernor({ dailyUsd: 10, monthlyUsd: 10 })
    governor.cost.add({ costUsd: 12 })
    governor.cost.grantOverride("day:*")
    const decision = governor.cost.check()
    // Approving the daily overrun does not authorise blowing the monthly one.
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.blockedBy.map((v) => v.scopeKey)).toEqual([
      "month:*",
    ])
    // The unconsumed daily grant is still held.
    expect(governor.cost.pendingOverrides()).toEqual(["day:*"])
  })

  it("blocks only the asked-about provider's scopes", () => {
    const { governor } = costGovernor({ perProviderDailyUsd: { anthropic: 1, openai: 100 } })
    governor.cost.add({ costUsd: 5, providerId: "anthropic" })
    expect(governor.cost.check("anthropic").allowed).toBe(false)
    expect(governor.cost.check("openai").allowed).toBe(true)
  })

  it("reconciles against a fresh read of the durable rollup", () => {
    const { governor } = costGovernor({ dailyUsd: 10 }, { dayUsd: 2, monthUsd: 2 })
    expect(governor.cost.worst()?.usedUsd).toBe(2)
    // The rollup is authoritative; the in-run delta was optimistic.
    governor.cost.syncSpend({ dayUsd: 7, monthUsd: 7 })
    expect(governor.cost.worst()?.usedUsd).toBe(7)
  })

  it("re-announces a scope that fell back below its threshold", () => {
    const { governor, onCostThreshold } = costGovernor({ dailyUsd: 10 })
    governor.cost.add({ costUsd: 9 })
    expect(onCostThreshold).toHaveBeenCalledTimes(1)
    // A new day resets the window; tomorrow's 90% deserves its own warning.
    governor.cost.syncSpend({ dayUsd: 0, monthUsd: 0 })
    governor.cost.syncSpend({ dayUsd: 9, monthUsd: 9 })
    expect(onCostThreshold).toHaveBeenCalledTimes(2)
  })

  it("ignores a zero or negative delta", () => {
    const { governor } = costGovernor({ dailyUsd: 10 })
    governor.cost.add({ costUsd: 0 })
    governor.cost.add({ costUsd: -5 })
    expect(governor.cost.worst()?.usedUsd).toBe(0)
  })

  it("keeps the token guard and the USD ceiling independent", () => {
    const { governor } = costGovernor({ dailyUsd: 10 })
    const child = governor.allocate("child")
    child.add({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 })
    // The same token count costs $0 on a local model and $25 on Opus — which
    // is exactly why the USD ceiling cannot be derived from tokens.
    expect(governor.cost.check().allowed).toBe(true)
  })
})
