import { defineRoutingStrategy } from "./define-routing-strategy"

describe("defineRoutingStrategy", () => {
  it("returns the routing strategy definition unchanged", () => {
    const def = {
      id: "cost-aware",
      label: "Cost Aware",
      description: "Prefers cheaper healthy deployments.",
      entry: "src/routing/cost-aware.ts",
      export: "createCostAwareStrategy",
    }

    expect(defineRoutingStrategy(def)).toBe(def)
  })
})
