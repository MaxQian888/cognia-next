import { resolveGatewayDecision } from "./decide"
import {
  ProviderRoutingEngine,
  RoutingNoCandidatesError,
} from "@/lib/ai/routing/provider-routing-engine"
import type { RoutingResult } from "@/lib/ai/routing/provider-routing-engine"

function engineReturning(result: RoutingResult | null): ProviderRoutingEngine {
  return { selectProvider: () => result } as unknown as ProviderRoutingEngine
}

function engineThrowing(err: unknown): ProviderRoutingEngine {
  return {
    selectProvider: () => {
      throw err
    },
  } as unknown as ProviderRoutingEngine
}

const req = { requestId: "r1", model: "fast" }

describe("resolveGatewayDecision", () => {
  it("returns the selected entry + fallback chain for an alias match", () => {
    const result = {
      providerId: "groq",
      modelId: "llama",
      strategy: "quality",
      fromAlias: true,
      alias: "fast",
      fallbackEntries: [{ providerId: "openai", modelId: "gpt-4o-mini" }],
      reason: "r",
    } as RoutingResult
    expect(resolveGatewayDecision(req, engineReturning(result))).toEqual([
      { providerId: "groq", modelId: "llama" },
      { providerId: "openai", modelId: "gpt-4o-mini" },
    ])
  })

  it("returns [] for a non-alias (direct/bare) result so the gateway uses its snapshot", () => {
    const direct = {
      providerId: "openai",
      modelId: "gpt-4o",
      strategy: "balanced",
      fromAlias: false,
      fallbackEntries: [],
      reason: "direct",
    } as RoutingResult
    expect(resolveGatewayDecision(req, engineReturning(direct))).toEqual([])
  })

  it("returns [] when the engine returns null", () => {
    expect(resolveGatewayDecision(req, engineReturning(null))).toEqual([])
  })

  it("returns [] when the alias matched but every deployment is unavailable", () => {
    expect(
      resolveGatewayDecision(req, engineThrowing(new RoutingNoCandidatesError("fast")))
    ).toEqual([])
  })

  it("re-throws unexpected errors", () => {
    expect(() => resolveGatewayDecision(req, engineThrowing(new Error("boom")))).toThrow("boom")
  })

  it("threads promptText + estimatedInputTokens into the engine", () => {
    const seen: unknown[] = []
    const engine = {
      selectProvider: (opts: unknown) => {
        seen.push(opts)
        return null
      },
    } as unknown as ProviderRoutingEngine
    resolveGatewayDecision(
      { requestId: "r", model: "fast", promptText: "hi", estimatedInputTokens: 42 },
      engine
    )
    expect(seen[0]).toMatchObject({ model: "fast", promptText: "hi", estimatedInputTokens: 42 })
  })
})
