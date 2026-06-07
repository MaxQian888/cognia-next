import { budgetFilter, circuitFilter, contextWindowFilter, rateLimitFilter } from "./built-in"
import type { FilterContext, FilterRequest } from "@/types/provider/deployment-filter"
import type { ModelMappingEntry, ProviderConstraint } from "@/types/provider/model-mapping"

const entries: ModelMappingEntry[] = [
  { providerId: "a", modelId: "m1" },
  { providerId: "b", modelId: "m2" },
]

const req: FilterRequest = { alias: "alias" }

function ctx(partial: Partial<FilterContext> = {}): FilterContext {
  return {
    telemetry: {
      getHealthMetrics: () => undefined,
      getPricing: () => undefined,
      getInFlight: () => 0,
      now: () => 0,
    },
    getCircuitBreakerState: () => "closed",
    isAvailable: () => true,
    constraints: [],
    now: () => 0,
    ...partial,
  }
}

describe("circuitFilter", () => {
  it("drops open-breaker and unavailable candidates", () => {
    const out = circuitFilter.filter(
      entries,
      req,
      ctx({ getCircuitBreakerState: (e) => (e.providerId === "a" ? "open" : "closed") })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b"])

    const out2 = circuitFilter.filter(
      entries,
      req,
      ctx({ isAvailable: (e) => e.providerId !== "b" })
    )
    expect(out2.candidates.map((e) => e.providerId)).toEqual(["a"])
  })

  it("keeps half-open candidates (probe allowed)", () => {
    const out = circuitFilter.filter(
      entries,
      req,
      ctx({ getCircuitBreakerState: () => "half-open" })
    )
    expect(out.candidates).toHaveLength(2)
  })
})

describe("contextWindowFilter", () => {
  const windows: Record<string, number> = { "a:m1": 8000, "b:m2": 200000 }
  const getContextWindow = (pid: string, mid: string) => windows[`${pid}:${mid}`] ?? 0

  it("passes through without an estimate or without the dep", () => {
    expect(
      contextWindowFilter.filter(entries, req, ctx({ getContextWindow })).candidates
    ).toHaveLength(2)
    expect(
      contextWindowFilter.filter(entries, { ...req, estimatedInputTokens: 50000 }, ctx()).candidates
    ).toHaveLength(2)
  })

  it("drops candidates that cannot fit the input", () => {
    const out = contextWindowFilter.filter(
      entries,
      { ...req, estimatedInputTokens: 50000 },
      ctx({ getContextWindow })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b"])
    expect(out.notes).toBeUndefined()
  })

  it("re-orders by window desc with the windowFallback note when nothing fits", () => {
    const out = contextWindowFilter.filter(
      entries,
      { ...req, estimatedInputTokens: 500000 },
      ctx({ getContextWindow })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b", "a"])
    expect(out.notes?.windowFallback).toBe(true)
  })
})

describe("rateLimitFilter", () => {
  const constraints: ProviderConstraint[] = [
    { providerId: "a", maxRequestsPerMinute: 10, enabled: true },
  ]

  it("passes through without getRate or constraints", () => {
    expect(rateLimitFilter.filter(entries, req, ctx()).candidates).toHaveLength(2)
    expect(
      rateLimitFilter.filter(entries, req, ctx({ getRate: () => ({ rpm: 99, tpm: 0 }) })).candidates
    ).toHaveLength(2)
  })

  it("drops candidates at their ceiling", () => {
    const out = rateLimitFilter.filter(
      entries,
      req,
      ctx({ constraints, getRate: () => ({ rpm: 10, tpm: 0 }) })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b"])
  })

  it("is advisory: keeps the input when every candidate is rate-limited", () => {
    const allConstrained: ProviderConstraint[] = [
      { providerId: "a", maxRequestsPerMinute: 1, enabled: true },
      { providerId: "b", maxRequestsPerMinute: 1, enabled: true },
    ]
    const out = rateLimitFilter.filter(
      entries,
      req,
      ctx({ constraints: allConstrained, getRate: () => ({ rpm: 5, tpm: 0 }) })
    )
    expect(out.candidates).toHaveLength(2)
  })

  it("ignores disabled constraints and ceilings that are not set", () => {
    const out = rateLimitFilter.filter(
      entries,
      req,
      ctx({
        constraints: [
          { providerId: "a", maxRequestsPerMinute: 1, enabled: false },
          { providerId: "b", enabled: true },
        ],
        getRate: () => ({ rpm: 99, tpm: 99 }),
      })
    )
    expect(out.candidates).toHaveLength(2)
  })
})

describe("budgetFilter", () => {
  const constraints: ProviderConstraint[] = [{ providerId: "a", dailyCostBudget: 5, enabled: true }]

  it("passes through without constraints", () => {
    expect(budgetFilter.filter(entries, req, ctx()).candidates).toHaveLength(2)
  })

  it("drops over-budget candidates when alternatives exist", () => {
    const out = budgetFilter.filter(
      entries,
      req,
      ctx({ constraints, getTodaySpend: (id) => (id === "a" ? 10 : 0) })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b"])
    expect(out.notes).toBeUndefined()
  })

  it("is advisory: keeps everything + overBudget note when all are over", () => {
    const allConstrained: ProviderConstraint[] = [
      { providerId: "a", dailyCostBudget: 5, enabled: true },
      { providerId: "b", dailyCostBudget: 5, enabled: true },
    ]
    const out = budgetFilter.filter(
      entries,
      req,
      ctx({ constraints: allConstrained, getTodaySpend: () => 10 })
    )
    expect(out.candidates).toHaveLength(2)
    expect(out.notes?.overBudget).toEqual([
      { providerId: "a", spend: 10, budget: 5 },
      { providerId: "b", spend: 10, budget: 5 },
    ])
  })

  it("falls back to health-metrics totalCost when no spend mirror is wired", () => {
    const out = budgetFilter.filter(
      entries,
      req,
      ctx({
        constraints,
        telemetry: {
          getHealthMetrics: (id) =>
            id === "a"
              ? ({ totalCost: 10 } as ReturnType<FilterContext["telemetry"]["getHealthMetrics"]>)
              : undefined,
          getPricing: () => undefined,
          getInFlight: () => 0,
          now: () => 0,
        },
      })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b"])
  })
})
