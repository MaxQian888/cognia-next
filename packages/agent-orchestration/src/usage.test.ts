import { contractChild, contractRun } from "./store-contract"
import { createMemoryTeamRunStore } from "./memory-store"
import { EMPTY_RESOURCE_USAGE, recordRunUsage, sumChildUsage } from "./usage"

const usage = (overrides: Partial<typeof EMPTY_RESOURCE_USAGE>) => ({
  ...EMPTY_RESOURCE_USAGE,
  ...overrides,
})

describe("sumChildUsage", () => {
  it("is empty for no children", () => {
    expect(sumChildUsage([])).toEqual(EMPTY_RESOURCE_USAGE)
  })

  it("adds counters, takes the longest wall time and omits cost nobody reported", () => {
    const total = sumChildUsage([
      { resourceUsage: usage({ promptTokens: 3, totalTokens: 5, wallTimeMs: 40, attempts: 1 }) },
      {
        resourceUsage: usage({
          promptTokens: 2,
          completionTokens: 4,
          totalTokens: 6,
          wallTimeMs: 90,
          toolTimeMs: 7,
          attempts: 2,
          failures: 1,
        }),
      },
    ])
    expect(total).toEqual({
      promptTokens: 5,
      completionTokens: 4,
      totalTokens: 11,
      wallTimeMs: 90,
      toolTimeMs: 7,
      attempts: 3,
      failures: 1,
    })
    expect(total).not.toHaveProperty("costUsd")
  })

  it("sums cost once any child reports it", () => {
    expect(
      sumChildUsage([
        { resourceUsage: usage({}) },
        { resourceUsage: usage({ costUsd: 0.25 }) },
        { resourceUsage: usage({ costUsd: 0.5 }) },
      ]).costUsd
    ).toBe(0.75)
  })
})

describe("recordRunUsage", () => {
  it("stores the children's fold on the run", async () => {
    const store = createMemoryTeamRunStore()
    await store.createRun(contractRun())
    await store.createChild({
      ...contractChild(),
      resourceUsage: usage({ totalTokens: 10, attempts: 1 }),
    })
    await store.createChild({
      ...contractChild({ id: "child-2" }),
      resourceUsage: usage({ totalTokens: 4, attempts: 2 }),
    })

    const recorded = await recordRunUsage(store, "run-1", 500)

    expect(recorded).toMatchObject({ totalTokens: 14, attempts: 3 })
    expect(await store.getRun("run-1")).toMatchObject({ resourceUsage: recorded, updatedAt: 500 })
  })
})
