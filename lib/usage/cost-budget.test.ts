import {
  budgetScopeKey,
  evaluateCostBudget,
  exceededScopes,
  formatBudgetRatio,
  worstCostBudgetVerdict,
  GLOBAL_BUDGET_TARGET,
  type CostBudgetPolicy,
  type CostBudgetSpend,
} from "./cost-budget"

const SPEND: CostBudgetSpend = {
  dayUsd: 8,
  monthUsd: 40,
  byProviderDayUsd: { anthropic: 6, openai: 2 },
  byProviderMonthUsd: { anthropic: 30, openai: 10 },
}

describe("evaluateCostBudget", () => {
  it("returns nothing when no scope is configured", () => {
    expect(evaluateCostBudget({}, SPEND)).toEqual([])
  })

  it("evaluates the global daily and monthly scopes independently", () => {
    const verdicts = evaluateCostBudget({ dailyUsd: 10, monthlyUsd: 100 }, SPEND)
    expect(verdicts).toEqual([
      {
        scopeKey: "day:*",
        period: "day",
        target: GLOBAL_BUDGET_TARGET,
        usedUsd: 8,
        limitUsd: 10,
        ratio: 0.8,
        level: "warning",
      },
      {
        scopeKey: "month:*",
        period: "month",
        target: GLOBAL_BUDGET_TARGET,
        usedUsd: 40,
        limitUsd: 100,
        ratio: 0.4,
        level: "ok",
      },
    ])
  })

  it("grades against the thresholds", () => {
    const level = (dayUsd: number): string =>
      evaluateCostBudget({ dailyUsd: 100 }, { dayUsd, monthUsd: 0 })[0].level
    expect(level(79)).toBe("ok")
    expect(level(80)).toBe("warning")
    expect(level(94)).toBe("warning")
    expect(level(95)).toBe("critical")
    expect(level(99.9)).toBe("critical")
    expect(level(100)).toBe("exceeded")
    expect(level(250)).toBe("exceeded")
  })

  it("honours custom thresholds and clamps nonsense ones", () => {
    expect(
      evaluateCostBudget({ dailyUsd: 100, warnAt: 0.5 }, { dayUsd: 60, monthUsd: 0 })[0].level
    ).toBe("warning")
    // A ratio outside 0–1 would make the grading meaningless.
    expect(
      evaluateCostBudget(
        { dailyUsd: 100, warnAt: -5, criticalAt: 99 },
        { dayUsd: 1, monthUsd: 0 }
      )[0].level
    ).toBe("warning")
  })

  it("reports an overshoot rather than capping the ratio", () => {
    // Capping at 1.0 would hide how far past the ceiling a run went.
    const [verdict] = evaluateCostBudget({ dailyUsd: 10 }, { dayUsd: 25, monthUsd: 0 })
    expect(verdict.ratio).toBe(2.5)
  })

  it("ignores a zero, negative or non-finite limit as 'no limit'", () => {
    const policy: CostBudgetPolicy = {
      dailyUsd: 0,
      monthlyUsd: -5,
      perProviderDailyUsd: { anthropic: Number.NaN },
    }
    expect(evaluateCostBudget(policy, SPEND)).toEqual([])
  })

  it("evaluates only the asked-about provider's scopes", () => {
    const policy: CostBudgetPolicy = {
      perProviderDailyUsd: { anthropic: 5, openai: 100 },
    }
    const scoped = evaluateCostBudget(policy, SPEND, "anthropic")
    // Another provider's cap has no bearing on "may anthropic spend?".
    expect(scoped.map((v) => v.scopeKey)).toEqual(["day:anthropic"])
    expect(scoped[0].level).toBe("exceeded")

    const all = evaluateCostBudget(policy, SPEND)
    expect(all.map((v) => v.scopeKey).sort()).toEqual(["day:anthropic", "day:openai"])
  })

  it("treats a provider with no recorded spend as zero", () => {
    const verdicts = evaluateCostBudget({ perProviderMonthlyUsd: { groq: 10 } }, SPEND)
    expect(verdicts[0]).toMatchObject({ usedUsd: 0, level: "ok" })
  })
})

describe("worstCostBudgetVerdict", () => {
  it("is null with nothing configured", () => {
    expect(worstCostBudgetVerdict([])).toBeNull()
  })

  it("picks the most severe scope, then the closest to its ceiling", () => {
    const verdicts = evaluateCostBudget(
      { dailyUsd: 10, monthlyUsd: 41, perProviderDailyUsd: { anthropic: 6 } },
      SPEND
    )
    // month is at 97.6% (critical) and anthropic/day is at 100% (exceeded).
    expect(worstCostBudgetVerdict(verdicts)?.scopeKey).toBe("day:anthropic")
  })

  it("breaks a severity tie on ratio", () => {
    const verdicts = evaluateCostBudget({ dailyUsd: 10, monthlyUsd: 46 }, SPEND)
    // day 80%, month ~87% — both warning.
    expect(worstCostBudgetVerdict(verdicts)?.scopeKey).toBe("month:*")
  })
})

describe("exceededScopes", () => {
  it("returns every scope at or past its ceiling", () => {
    const verdicts = evaluateCostBudget(
      { dailyUsd: 8, monthlyUsd: 40, perProviderDailyUsd: { openai: 100 } },
      SPEND
    )
    expect(exceededScopes(verdicts).map((v) => v.scopeKey)).toEqual(["day:*", "month:*"])
  })
})

describe("helpers", () => {
  it("builds a stable scope key", () => {
    expect(budgetScopeKey("day", GLOBAL_BUDGET_TARGET)).toBe("day:*")
    expect(budgetScopeKey("month", "anthropic")).toBe("month:anthropic")
  })

  it("formats a ratio for display", () => {
    expect(formatBudgetRatio(0.974)).toBe("97.4%")
    expect(formatBudgetRatio(Number.NaN)).toBe("0%")
  })
})
