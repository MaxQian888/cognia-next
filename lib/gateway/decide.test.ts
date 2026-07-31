import { resolveGatewayDecision } from "./decide"
import {
  ProviderRoutingEngine,
  RoutingNoCandidatesError,
} from "@cognia/provider-routing/provider-routing-engine"
import type { RoutingResult } from "@cognia/provider-routing/provider-routing-engine"

function engineReturning(result: RoutingResult | null): ProviderRoutingEngine {
  return {
    planRoute: async () => {
      if (!result?.fromAlias) throw new RoutingNoCandidatesError("fast")
      const orderedCandidates = [
        { providerId: result.providerId, modelId: result.modelId },
        ...result.fallbackEntries,
      ].map((entry) => ({
        ...entry,
        deploymentId: `${entry.providerId}::${entry.modelId}`,
        reasonCodes: [],
      }))
      return {
        decisionId: "d",
        surface: "gateway",
        requested: { kind: "alias", alias: result.alias ?? "fast" },
        strategy: result.strategy,
        selected: orderedCandidates[0],
        orderedCandidates,
        reasonCodes: [],
        rejected: [],
        replayPolicy: "pre-commit-only",
        createdAt: 1,
      }
    },
  } as unknown as ProviderRoutingEngine
}

function engineThrowing(err: unknown): ProviderRoutingEngine {
  return {
    planRoute: async () => {
      throw err
    },
  } as unknown as ProviderRoutingEngine
}

const req = { requestId: "r1", model: "fast" }

describe("resolveGatewayDecision", () => {
  it("returns the selected entry + fallback chain for an alias match", async () => {
    const result = {
      providerId: "groq",
      modelId: "llama",
      strategy: "quality",
      fromAlias: true,
      alias: "fast",
      fallbackEntries: [{ providerId: "openai", modelId: "gpt-4o-mini" }],
      reason: "r",
    } as RoutingResult
    await expect(resolveGatewayDecision(req, engineReturning(result))).resolves.toEqual([
      { providerId: "groq", modelId: "llama" },
      { providerId: "openai", modelId: "gpt-4o-mini" },
    ])
  })

  it("returns [] for a non-alias (direct/bare) result so the gateway uses its snapshot", async () => {
    const direct = {
      providerId: "openai",
      modelId: "gpt-4o",
      strategy: "balanced",
      fromAlias: false,
      fallbackEntries: [],
      reason: "direct",
    } as RoutingResult
    await expect(resolveGatewayDecision(req, engineReturning(direct))).resolves.toEqual([])
  })

  it("returns [] when the engine returns null", async () => {
    await expect(resolveGatewayDecision(req, engineReturning(null))).resolves.toEqual([])
  })

  it("returns [] when the alias matched but every deployment is unavailable", async () => {
    await expect(
      resolveGatewayDecision(req, engineThrowing(new RoutingNoCandidatesError("fast")))
    ).resolves.toEqual([])
  })

  it("falls back to the gateway snapshot when planning exceeds the decision deadline", async () => {
    const engine = {
      planRoute: () => new Promise(() => undefined),
    } as unknown as ProviderRoutingEngine
    await expect(resolveGatewayDecision(req, engine, 5)).resolves.toEqual([])
  })

  it("re-throws unexpected errors", async () => {
    await expect(resolveGatewayDecision(req, engineThrowing(new Error("boom")))).rejects.toThrow(
      "boom"
    )
  })

  it("threads promptText + estimatedInputTokens + sessionId into the engine", async () => {
    const seen: unknown[] = []
    const engine = {
      planRoute: async (opts: unknown) => {
        seen.push(opts)
        throw new RoutingNoCandidatesError("fast")
      },
    } as unknown as ProviderRoutingEngine
    await resolveGatewayDecision(
      {
        requestId: "r",
        model: "fast",
        promptText: "hi",
        estimatedInputTokens: 42,
        sessionId: "gw-cc-abc",
      },
      engine,
      undefined,
      { locality: "local-only", excludedProviderIds: ["cloud"] }
    )
    expect(seen[0]).toMatchObject({
      surface: "gateway",
      selection: { kind: "alias", alias: "fast" },
      promptText: "hi",
      estimatedInputTokens: 42,
      sessionId: "gw-cc-abc",
      dataPolicy: { locality: "local-only", excludedProviderIds: ["cloud"] },
    })
  })

  it("omits sessionId when absent so affinity stays untouched", async () => {
    const seen: Array<Record<string, unknown>> = []
    const engine = {
      planRoute: async (opts: Record<string, unknown>) => {
        seen.push(opts)
        throw new RoutingNoCandidatesError("fast")
      },
    } as unknown as ProviderRoutingEngine
    await resolveGatewayDecision({ requestId: "r", model: "fast" }, engine)
    expect("sessionId" in seen[0]).toBe(false)
  })
})
