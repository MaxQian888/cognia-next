import {
  getRoutingStrategy,
  registerRoutingStrategy,
  unregisterRoutingStrategy,
  unregisterRoutingStrategiesByPlugin,
  listRoutingStrategies,
  __resetRoutingStrategiesForTesting,
} from "./strategy-registry"
import { leastBusySelector, makeTelemetrySnapshot } from "./strategies/built-in"
import { ProviderRoutingEngine } from "./provider-routing-engine"
import type { ModelMappingEntry, ModelMappingRegistry } from "@/types/provider/model-mapping"
import type { RoutingStrategySelector } from "@/types/provider/routing-strategy"

const entriesOf = (...providerIds: string[]): ModelMappingEntry[] =>
  providerIds.map((providerId) => ({ providerId, modelId: `${providerId}-model` }))

describe("strategy-registry", () => {
  afterEach(() => {
    __resetRoutingStrategiesForTesting()
  })

  it("resolves every built-in id and lists them first", () => {
    for (const id of ["quality", "cost", "speed", "balanced", "adaptive", "least-busy"]) {
      expect(getRoutingStrategy(id)?.id).toBe(id)
    }
    const listed = listRoutingStrategies()
    expect(listed.slice(0, 6).every((s) => s.builtIn)).toBe(true)
  })

  it("registers customs, lists them with plugin tags, and unregisters by plugin", () => {
    const custom: RoutingStrategySelector = {
      id: "my-plugin:always-last",
      label: "Always last",
      select: (entries) => entries[entries.length - 1] ?? null,
    }
    expect(registerRoutingStrategy(custom, { pluginId: "my-plugin" })).toBe(true)
    expect(getRoutingStrategy("my-plugin:always-last")).toBe(custom)
    expect(listRoutingStrategies()).toContainEqual(
      expect.objectContaining({
        id: "my-plugin:always-last",
        label: "Always last",
        pluginId: "my-plugin",
      })
    )
    expect(unregisterRoutingStrategiesByPlugin("my-plugin")).toBe(1)
    expect(getRoutingStrategy("my-plugin:always-last")).toBeUndefined()
  })

  it("refuses to shadow a built-in id", () => {
    const impostor: RoutingStrategySelector = {
      id: "cost",
      select: (entries) => entries[entries.length - 1] ?? null,
    }
    expect(registerRoutingStrategy(impostor)).toBe(false)
    // The built-in stays authoritative.
    expect(getRoutingStrategy("cost")).not.toBe(impostor)
  })

  it("unregisterRoutingStrategy drops a single custom", () => {
    registerRoutingStrategy({ id: "x", select: () => null })
    expect(unregisterRoutingStrategy("x")).toBe(true)
    expect(unregisterRoutingStrategy("x")).toBe(false)
  })
})

describe("least-busy selector", () => {
  it("picks the provider with the fewest in-flight requests", () => {
    const counts: Record<string, number> = { a: 3, b: 1, c: 2 }
    const telemetry = makeTelemetrySnapshot({
      getHealthMetrics: () => undefined,
      getPricing: () => undefined,
      getInFlight: (id) => counts[id] ?? 0,
    })
    expect(leastBusySelector.select(entriesOf("a", "b", "c"), telemetry)?.providerId).toBe("b")
  })

  it("degrades to chain order when no counter is wired", () => {
    const telemetry = makeTelemetrySnapshot({
      getHealthMetrics: () => undefined,
      getPricing: () => undefined,
    })
    expect(leastBusySelector.select(entriesOf("a", "b"), telemetry)?.providerId).toBe("a")
    expect(leastBusySelector.select([], telemetry)).toBeNull()
  })
})

describe("engine ↔ registry integration", () => {
  afterEach(() => {
    __resetRoutingStrategiesForTesting()
  })

  const registry: ModelMappingRegistry = {
    enabled: true,
    mappings: [
      {
        id: "m1",
        alias: "fast",
        enabled: true,
        providers: entriesOf("a", "b", "c"),
      },
    ],
  } as unknown as ModelMappingRegistry

  const makeEngine = (getInFlight?: (id: string) => number) =>
    new ProviderRoutingEngine(
      registry,
      {
        strategy: "quality",
        allowPerRequestOverride: true,
        providerConstraints: [],
        requestTimeoutMs: 30000,
        maxFallbackAttempts: 3,
      } as never,
      {
        getHealthMetrics: () => undefined,
        getCircuitBreakerState: () => "closed",
        isProviderAvailable: () => true,
        getPricing: () => undefined,
        getInFlight,
      }
    )

  it("routes through a registered custom strategy via override", () => {
    registerRoutingStrategy({
      id: "pick-last",
      select: (entries) => entries[entries.length - 1] ?? null,
    })
    const result = makeEngine().selectProvider({
      model: "fast",
      override: { modelAlias: "fast", strategy: "pick-last" as never },
    })
    expect(result?.providerId).toBe("c")
    expect(result?.strategy).toBe("pick-last")
  })

  it("least-busy override consults the engine's in-flight dep", () => {
    const counts: Record<string, number> = { a: 5, b: 0, c: 2 }
    const result = makeEngine((id) => counts[id] ?? 0).selectProvider({
      model: "fast",
      override: { modelAlias: "fast", strategy: "least-busy" as never },
    })
    expect(result?.providerId).toBe("b")
  })

  it("an unknown strategy id and a throwing selector both degrade to the first entry", () => {
    const unknown = makeEngine().selectProvider({
      model: "fast",
      override: { modelAlias: "fast", strategy: "ghost-strategy" as never },
    })
    expect(unknown?.providerId).toBe("a")

    registerRoutingStrategy({
      id: "boom",
      select: () => {
        throw new Error("selector exploded")
      },
    })
    const throwing = makeEngine().selectProvider({
      model: "fast",
      override: { modelAlias: "fast", strategy: "boom" as never },
    })
    expect(throwing?.providerId).toBe("a")
  })
})
