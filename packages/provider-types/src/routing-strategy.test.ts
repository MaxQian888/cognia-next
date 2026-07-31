import type { RoutingStrategySelector, RoutingTelemetrySnapshot } from "./routing-strategy"

describe("RoutingStrategySelector contract", () => {
  it("selects from immutable mapping entries with telemetry", () => {
    const telemetry: RoutingTelemetrySnapshot = {
      getHealthMetrics: () => undefined,
      getPricing: (_providerId, modelId) => (modelId === "cheap" ? 0.1 : 1),
      getInFlight: () => 0,
      now: () => 123,
    }
    const selector: RoutingStrategySelector = {
      id: "cost",
      select(entries, t) {
        return (
          [...entries].sort(
            (a, b) =>
              (t.getPricing(a.providerId, a.modelId) ?? Number.POSITIVE_INFINITY) -
              (t.getPricing(b.providerId, b.modelId) ?? Number.POSITIVE_INFINITY)
          )[0] ?? null
        )
      },
    }

    expect(
      selector.select(
        [
          { providerId: "openai", modelId: "expensive" },
          { providerId: "groq", modelId: "cheap" },
        ],
        telemetry
      )
    ).toEqual({ providerId: "groq", modelId: "cheap" })
    expect(telemetry.now()).toBe(123)
  })
})
