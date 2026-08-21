import type { RoutingPlan } from "@cognia/provider-types/auto-router"

import { routingPlanTraceAttributes } from "./plan-trace-attributes"

function plan(over: Partial<RoutingPlan> = {}): RoutingPlan {
  return {
    decisionId: "d1",
    surface: "chat",
    requested: { kind: "auto" },
    strategy: "reliability",
    selected: { providerId: "p1", modelId: "m1", deploymentId: "p1::m1", reasonCodes: [] },
    orderedCandidates: [
      { providerId: "p1", modelId: "m1", deploymentId: "p1::m1", reasonCodes: [] },
      { providerId: "p2", modelId: "m2", deploymentId: "p2::m2", reasonCodes: [] },
    ],
    reasonCodes: ["auto-task-fit"],
    rejected: [],
    replayPolicy: "pre-commit-only",
    createdAt: 1,
    ...over,
  } as RoutingPlan
}

describe("routingPlanTraceAttributes", () => {
  it("carries the identity and shape both emit sites need", () => {
    expect(routingPlanTraceAttributes(plan())).toMatchObject({
      decisionId: "d1",
      surface: "chat",
      strategy: "reliability",
      providerId: "p1",
      modelId: "m1",
      candidateCount: 2,
      reasonCodes: ["auto-task-fit"],
    })
  })

  it("keeps the deterministic and final tiers side by side", () => {
    // When a judge moved the decision, the pair IS the record of the
    // disagreement — calibration cannot say whether asking was worth it from
    // either half alone.
    const attributes = routingPlanTraceAttributes(
      plan({
        difficulty: {
          score: 0.8,
          tier: "powerful",
          deterministicTier: "balanced",
          judgeUsed: true,
          judgeTier: "powerful",
          judgeConfidence: 0.7,
          judgeLatencyMs: 210,
          signals: {
            length: 0.1,
            code: 0,
            keywords: 0.15,
            structure: 0,
            attachments: 0,
            threadDepth: 0,
            tools: 0,
            effortFloor: 0,
          },
        },
      })
    )
    expect(attributes).toMatchObject({
      deterministicTier: "balanced",
      difficultyTier: "powerful",
      judgeUsed: true,
      judgeTier: "powerful",
      judgeConfidence: 0.7,
      judgeLatencyMs: 210,
    })
  })

  it("prefers the routed score over the classification's when a judge moved it", () => {
    // Otherwise calibration tunes thresholds against a number the router did
    // not actually route on.
    const attributes = routingPlanTraceAttributes(
      plan({
        classification: {
          difficultyScore: 0.3,
          complexity: "moderate",
          category: "general",
        } as never,
        difficulty: {
          score: 0.84,
          tier: "powerful",
          deterministicTier: "balanced",
          judgeUsed: true,
          judgeTier: "powerful",
          signals: {
            length: 0,
            code: 0,
            keywords: 0,
            structure: 0,
            attachments: 0,
            threadDepth: 0,
            tools: 0,
            effortFloor: 0,
          },
        },
      })
    )
    expect(attributes.difficultyScore).toBe(0.84)
    expect(attributes.category).toBe("general")
  })

  it("emits numbers and enums only — never prompt text", () => {
    const attributes = routingPlanTraceAttributes(
      plan({
        difficulty: {
          score: 0.4,
          tier: "balanced",
          deterministicTier: "balanced",
          judgeUsed: false,
          signals: {
            length: 0.3,
            code: 0.25,
            keywords: 0.3,
            structure: 0.1,
            attachments: 0.2,
            threadDepth: 0.15,
            tools: 0.15,
            effortFloor: 0,
          },
        },
      })
    )
    for (const value of Object.values(attributes.signals ?? {})) {
      expect(typeof value).toBe("number")
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    // Every string in the payload is an id or an enum the router chose — none
    // of it is caller-supplied prose.
    const STRING_KEYS = new Set([
      "decisionId",
      "surface",
      "strategy",
      "providerId",
      "modelId",
      "category",
      "complexity",
      "deterministicTier",
      "difficultyTier",
      "judgeTier",
    ])
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === "string") expect(STRING_KEYS.has(key)).toBe(true)
      if (Array.isArray(value)) {
        expect(key).toBe("reasonCodes")
        for (const item of value) expect(typeof item).toBe("string")
      }
    }
  })

  it("omits the difficulty block entirely for a pinned model", () => {
    const attributes = routingPlanTraceAttributes(plan({ reasonCodes: ["manual-override"] }))
    expect(attributes.judgeUsed).toBeUndefined()
    expect(attributes.signals).toBeUndefined()
    expect(attributes.deterministicTier).toBeUndefined()
  })
})
