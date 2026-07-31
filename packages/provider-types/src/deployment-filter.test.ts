import type {
  DeploymentFilter,
  FilterContext,
  FilterOutcome,
  FilterRequest,
} from "./deployment-filter"

describe("DeploymentFilter contract", () => {
  it("filters candidates with request and context inputs", () => {
    const filter: DeploymentFilter = {
      id: "only-openai",
      filter(candidates, req: FilterRequest, _ctx: FilterContext): FilterOutcome {
        return {
          candidates: candidates.filter((candidate) => candidate.providerId === req.alias),
          notes: { prunedBy: ["only-openai"] },
        }
      },
    }

    const outcome = filter.filter(
      [
        { providerId: "openai", modelId: "gpt-4o" },
        { providerId: "anthropic", modelId: "claude-sonnet" },
      ],
      { alias: "openai" },
      {
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
    )

    expect(outcome).toEqual({
      candidates: [{ providerId: "openai", modelId: "gpt-4o" }],
      notes: { prunedBy: ["only-openai"] },
    })
  })
})
