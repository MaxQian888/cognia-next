import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { analyzeRoutingCalibration } from "./calibration"

function spans(scores: number[], shadowDiffIndexes: number[] = []): AgentTraceSpan[] {
  const diffs = new Set(shadowDiffIndexes)
  return scores.map((difficultyScore, index) => ({
    id: `span-${index}`,
    traceId: `trace-${index}`,
    spanId: `span-${index}`,
    startTime: index,
    operationName: "chat",
    providerName: "openai",
    sessionId: `session-${index}`,
    surface: "chat",
    events: [
      {
        name: "routing.plan",
        at: index,
        attributes: { decisionId: `decision-${index}`, difficultyScore },
      },
      ...(diffs.has(index)
        ? [
            {
              name: "routing.shadow_diff",
              at: index,
              attributes: { decisionId: `decision-${index}` },
            },
          ]
        : []),
    ],
  }))
}

describe("analyzeRoutingCalibration", () => {
  it("ignores malformed, partial, and unbounded trace features", () => {
    const malformed = [
      {
        id: "span",
        traceId: "trace",
        spanId: "span",
        startTime: 0,
        operationName: "chat",
        providerName: "openai",
        sessionId: "session",
        surface: "chat",
        events: [
          { name: "routing.plan", at: 0 },
          {
            name: "routing.plan",
            at: 1,
            attributes: { decisionId: 42, difficultyScore: 0.5 },
          },
          {
            name: "routing.plan",
            at: 2,
            attributes: { decisionId: "nan", difficultyScore: Number.NaN },
          },
          {
            name: "routing.plan",
            at: 3,
            attributes: { decisionId: "string", difficultyScore: "0.5" },
          },
          {
            name: "routing.plan",
            at: 4,
            attributes: { decisionId: "high", difficultyScore: 1.1 },
          },
          {
            name: "routing.shadow_diff",
            at: 5,
            attributes: { decisionId: "missing-plan" },
          },
        ],
      },
    ] as unknown as AgentTraceSpan[]

    expect(analyzeRoutingCalibration(malformed, { balanced: 0.34, powerful: 0.67 })).toMatchObject({
      status: "insufficient-total",
      sampleSize: 0,
      shadowDiffRate: 0,
      confidence: 0,
    })
  })

  it("requires at least fifty bounded decisions", () => {
    const result = analyzeRoutingCalibration(spans([0.1, 0.5, 1, -1, 2]), {
      balanced: 0.34,
      powerful: 0.67,
    })

    expect(result).toMatchObject({
      status: "insufficient-total",
      sampleSize: 3,
      perTier: { fast: 1, balanced: 1, powerful: 1 },
    })
  })

  it("requires adequate samples in every current tier", () => {
    const result = analyzeRoutingCalibration(spans(Array.from({ length: 50 }, () => 0.1)), {
      balanced: 0.34,
      powerful: 0.67,
    })

    expect(result.status).toBe("insufficient-tier")
    expect(result.perTier).toEqual({ fast: 50, balanced: 0, powerful: 0 })
  })

  it("returns a bounded recommendation, confidence, and shadow difference rate", () => {
    const scores = [
      ...Array.from({ length: 20 }, (_, index) => 0.05 + index * 0.01),
      ...Array.from({ length: 20 }, (_, index) => 0.4 + index * 0.01),
      ...Array.from({ length: 20 }, (_, index) => 0.72 + index * 0.01),
    ]
    const result = analyzeRoutingCalibration(spans(scores, [0, 1, 2, 3, 4, 5]), {
      balanced: 0.34,
      powerful: 0.67,
    })

    expect(result.status).toBe("ready")
    expect(result.recommendedThresholds?.balanced).toBeLessThan(
      result.recommendedThresholds?.powerful ?? 0
    )
    expect(result.shadowDiffRate).toBeCloseTo(0.1)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it("clamps tightly clustered high-score recommendations to valid thresholds", () => {
    const scores = [
      ...Array.from({ length: 20 }, () => 0.98),
      ...Array.from({ length: 20 }, () => 0.99),
      ...Array.from({ length: 20 }, () => 1),
    ]
    const result = analyzeRoutingCalibration(spans(scores), {
      balanced: 0.985,
      powerful: 0.995,
    })

    expect(result.status).toBe("ready")
    expect(result.recommendedThresholds).toEqual({ balanced: 0.99, powerful: 1 })
  })
})
