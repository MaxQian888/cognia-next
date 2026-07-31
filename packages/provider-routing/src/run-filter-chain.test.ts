import { runFilterChain, runFilterChainAsync } from "./run-filter-chain"
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

describe("runFilterChainAsync", () => {
  it("awaits asynchronous filters, merges notes, and records pruning", async () => {
    const asyncFilter: DeploymentFilter = {
      id: "async",
      filter: (candidates) => ({ candidates: [...candidates] }),
      filterAsync: async (candidates) => ({
        candidates: candidates.filter((entry) => entry.providerId !== "a"),
        notes: { windowFallback: true },
      }),
    }

    const out = await runFilterChainAsync([asyncFilter], entries, req, ctx(), 50)

    expect(out.candidates.map((entry) => entry.providerId)).toEqual(["b", "c"])
    expect(out.notes).toMatchObject({ prunedBy: ["async"], windowFallback: true })
  })

  it.each([
    {
      name: "invalid output",
      filter: {
        id: "invalid",
        filter: () => ({ candidates: [] }),
        filterAsync: async () => ({ candidates: [{ providerId: 1, modelId: "bad" }] }),
      } as unknown as DeploymentFilter,
      kind: "invalid",
    },
    {
      name: "non-string model id",
      filter: {
        id: "invalid-model",
        filter: () => ({ candidates: [] }),
        filterAsync: async () => ({ candidates: [{ providerId: "valid", modelId: 1 }] }),
      } as unknown as DeploymentFilter,
      kind: "invalid",
    },
    {
      name: "undefined output",
      filter: {
        id: "undefined",
        filter: () => ({ candidates: [] }),
        filterAsync: async () => undefined,
      } as unknown as DeploymentFilter,
      kind: "invalid",
    },
    {
      name: "null candidate list",
      filter: {
        id: "null-candidates",
        filter: () => ({ candidates: [] }),
        filterAsync: async () => ({ candidates: null }),
      } as unknown as DeploymentFilter,
      kind: "invalid",
    },
    {
      name: "exception",
      filter: {
        id: "error",
        filter: () => ({ candidates: [] }),
        filterAsync: async () => {
          throw new Error("broken plugin")
        },
      } satisfies DeploymentFilter,
      kind: "error",
    },
  ])("keeps the safe candidate list after $name", async ({ filter, kind }) => {
    const out = await runFilterChainAsync([filter], entries, req, ctx(), 50)

    expect(out.candidates).toEqual(entries)
    expect(out.notes?.filterErrors).toEqual([{ filterId: filter.id, kind }])
  })

  it("times out a slow filter and continues with the next filter", async () => {
    const slow: DeploymentFilter = {
      id: "slow",
      filter: (candidates) => ({ candidates: [...candidates] }),
      filterAsync: () => new Promise(() => undefined),
    }

    const out = await runFilterChainAsync([slow, dropProvider("next", "a")], entries, req, ctx(), 1)

    expect(out.candidates.map((entry) => entry.providerId)).toEqual(["b", "c"])
    expect(out.notes?.filterErrors).toEqual([{ filterId: "slow", kind: "timeout" }])
  })

  it("merges plugin-provided filter errors with later host errors", async () => {
    const contributed: DeploymentFilter = {
      id: "contributed",
      filter: (candidates) => ({
        candidates: [...candidates],
        notes: { filterErrors: [{ filterId: "nested", kind: "error" }] },
      }),
    }
    const invalid = {
      id: "invalid",
      filter: () => ({ candidates: [] }),
      filterAsync: async () => undefined,
    } as unknown as DeploymentFilter

    const out = await runFilterChainAsync([contributed, invalid], entries, req, ctx(), 50)

    expect(out.notes?.filterErrors).toEqual([
      { filterId: "nested", kind: "error" },
      { filterId: "invalid", kind: "invalid" },
    ])
  })

  it("short-circuits after an async filter removes every candidate", async () => {
    const next = jest.fn((candidates: ReadonlyArray<ModelMappingEntry>) => ({
      candidates: [...candidates],
    }))
    const out = await runFilterChainAsync(
      [
        {
          id: "all",
          filter: () => ({ candidates: [] }),
          filterAsync: async () => ({ candidates: [] }),
        },
        { id: "next", filter: next },
      ],
      entries,
      req,
      ctx(),
      50
    )

    expect(out.candidates).toEqual([])
    expect(next).not.toHaveBeenCalled()
  })
})
