import {
  BUILT_IN_ROUTING_SELECTORS,
  adaptiveSelector,
  balancedSelector,
  costSelector,
  leastBusySelector,
  makeTelemetrySnapshot,
  qualitySelector,
  speedSelector,
} from "./built-in"
import type { ProviderHealthMetrics } from "@cognia/provider-types/health-metrics"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import type { RoutingTelemetrySnapshot } from "@cognia/provider-types/routing-strategy"

const entries: ModelMappingEntry[] = [
  { providerId: "openai", modelId: "gpt-4o" },
  { providerId: "groq", modelId: "llama" },
  { providerId: "anthropic", modelId: "sonnet" },
]

function metrics(partial: Partial<ProviderHealthMetrics>): ProviderHealthMetrics {
  return partial as ProviderHealthMetrics
}

function telemetry(
  parts: {
    pricing?: Record<string, number>
    health?: Record<string, ProviderHealthMetrics>
    inFlight?: Record<string, number>
    now?: number
  } = {}
): RoutingTelemetrySnapshot {
  return makeTelemetrySnapshot({
    getHealthMetrics: (providerId) => parts.health?.[providerId],
    getPricing: (providerId, modelId) => parts.pricing?.[`${providerId}:${modelId}`],
    getInFlight: (providerId) => parts.inFlight?.[providerId] ?? 0,
    now: () => parts.now ?? 1_000_000,
  })
}

describe("built-in routing selectors", () => {
  it("registers the canonical selector set", () => {
    expect(BUILT_IN_ROUTING_SELECTORS.map((selector) => selector.id)).toEqual([
      "quality",
      "cost",
      "speed",
      "balanced",
      "adaptive",
      "least-busy",
    ])
  })

  it("selects by quality, cost, speed, and least-busy signals", () => {
    expect(qualitySelector.select(entries, telemetry())).toBe(entries[0])
    expect(
      costSelector.select(
        entries,
        telemetry({ pricing: { "openai:gpt-4o": 10, "groq:llama": 0.2 } })
      )
    ).toBe(entries[1])
    expect(
      speedSelector.select(
        entries,
        telemetry({
          health: {
            openai: metrics({ latencyP50: 1000 }),
            anthropic: metrics({ latencyP50: 300 }),
          },
        })
      )
    ).toBe(entries[2])
    expect(leastBusySelector.select(entries, telemetry({ inFlight: { openai: 5, groq: 1 } }))).toBe(
      entries[2]
    )
  })

  it("scores balanced and adaptive selectors with success, latency, price, and recency", () => {
    expect(
      balancedSelector.select(
        entries,
        telemetry({
          health: {
            openai: metrics({ successRate: 0.3, latencyP50: 5000 }),
            groq: metrics({ successRate: 0.99, latencyP50: 100 }),
          },
          pricing: { "openai:gpt-4o": 30, "groq:llama": 0.1 },
        })
      )
    ).toBe(entries[1])

    expect(
      adaptiveSelector.select(
        entries,
        telemetry({
          now: 1_000_000,
          health: {
            openai: metrics({ successRate: 0.99, latencyP50: 100, lastErrorAt: 999_000 }),
            groq: metrics({ successRate: 0.8, latencyP50: 200 }),
          },
        })
      )
    ).toBe(entries[1])
  })

  it("returns null for empty candidate lists", () => {
    expect(costSelector.select([], telemetry())).toBeNull()
    expect(speedSelector.select([], telemetry())).toBeNull()
    expect(balancedSelector.select([], telemetry())).toBeNull()
    expect(adaptiveSelector.select([], telemetry())).toBeNull()
    expect(leastBusySelector.select([], telemetry())).toBeNull()
  })
})
