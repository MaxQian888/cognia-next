import { runFilterChain } from "./run-filter-chain"
import type {
  DeploymentFilter,
  FilterContext,
  FilterRequest,
} from "@cognia/provider-types/deployment-filter"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"

const entries: ModelMappingEntry[] = [
  { providerId: "a", modelId: "m1" },
  { providerId: "b", modelId: "m2" },
  { providerId: "c", modelId: "m3" },
]

const req: FilterRequest = { alias: "alias" }

function ctx(): FilterContext {
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
  }
}

function dropProvider(id: string, providerId: string): DeploymentFilter {
  return {
    id,
    filter: (candidates) => ({
      candidates: candidates.filter((e) => e.providerId !== providerId),
    }),
  }
}

describe("runFilterChain", () => {
  it("runs filters in order and reports which ones pruned", () => {
    const out = runFilterChain(
      [dropProvider("f1", "a"), dropProvider("f2", "ghost")],
      entries,
      req,
      ctx()
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b", "c"])
    expect(out.notes?.prunedBy).toEqual(["f1"]) // f2 pruned nothing
  })

  it("merges notes across filters", () => {
    const noteA: DeploymentFilter = {
      id: "a",
      filter: (candidates) => ({ candidates: [...candidates], notes: { windowFallback: true } }),
    }
    const noteB: DeploymentFilter = {
      id: "b",
      filter: (candidates) => ({
        candidates: [...candidates],
        notes: { affinityPinned: "a::m1", overBudget: [{ providerId: "a", spend: 2, budget: 1 }] },
      }),
    }
    const out = runFilterChain([noteA, noteB], entries, req, ctx())
    expect(out.notes?.windowFallback).toBe(true)
    expect(out.notes?.affinityPinned).toBe("a::m1")
    expect(out.notes?.overBudget).toHaveLength(1)
  })

  it("skips a throwing filter and keeps going", () => {
    const boom: DeploymentFilter = {
      id: "boom",
      filter: () => {
        throw new Error("filter exploded")
      },
    }
    const out = runFilterChain([boom, dropProvider("f", "a")], entries, req, ctx())
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b", "c"])
  })

  it("short-circuits once the list is empty", () => {
    const calls: string[] = []
    const dropAll: DeploymentFilter = { id: "all", filter: () => ({ candidates: [] }) }
    const spy: DeploymentFilter = {
      id: "spy",
      filter: (candidates) => {
        calls.push("spy")
        return { candidates: [...candidates] }
      },
    }
    const out = runFilterChain([dropAll, spy], entries, req, ctx())
    expect(out.candidates).toEqual([])
    expect(calls).toEqual([])
  })

  it("does not mutate the input candidate list", () => {
    const input = [...entries]
    runFilterChain([dropProvider("f", "a")], input, req, ctx())
    expect(input).toHaveLength(3)
  })
})
