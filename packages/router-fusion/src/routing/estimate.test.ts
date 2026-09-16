import { defaultExtension } from "../config/builtin-catalog"
import { SPEC_MOCK_REGISTRY } from "../fake/mock-registry"
import type { FusionDeployment } from "../config/types"
import {
  estimateAction,
  expectedForCall,
  plannedCalls,
  reserveForCall,
  type EstimateContext,
} from "./estimate"

const byId = Object.fromEntries(SPEC_MOCK_REGISTRY.deployments.map((d) => [d.id, d])) as Record<
  string,
  FusionDeployment
>
const context: EstimateContext = {
  rateCardsById: Object.fromEntries(SPEC_MOCK_REGISTRY.rate_cards.map((c) => [c.id, c])),
  unknownPriceCallReserveMicrousd: 50_000,
  expectedOutputTokens: 500,
}

describe("estimates", () => {
  it("reserves cold-cache worst case: every input token at the highest write tier and the full output", () => {
    const baseline = byId["fake-baseline"]
    // input 10k × $1/M = 10,000; output min(8192, 4096) × $2/M = 8,192
    expect(
      reserveForCall({ deployment: baseline, inputTokens: 10_000, outputTokens: 8192 }, context)
    ).toEqual({
      microusd: 18_192,
      priceKnown: true,
    })
    expect(
      expectedForCall({ deployment: baseline, inputTokens: 10_000, outputTokens: 8192 }, context)
    ).toBe(11_000)
  })

  it("uses the conservative placeholder for an unpriced deployment and says so", () => {
    const unpriced = { ...byId["fake-baseline"], rateCardId: null }
    expect(
      reserveForCall({ deployment: unpriced, inputTokens: 1, outputTokens: 1 }, context)
    ).toEqual({
      microusd: 50_000,
      priceKnown: false,
    })
    expect(
      expectedForCall({ deployment: unpriced, inputTokens: 1, outputTokens: 1 }, context)
    ).toBeNull()
  })

  it("reserves the whole panel tail as a stage before the fan-out (BUD-02 precondition)", () => {
    const estimate = estimateAction(
      {
        mode: "panel",
        extension: defaultExtension("panel"),
        roles: {
          panel_a: byId["fake-economy"],
          panel_b: byId["fake-independent"],
          judge: byId["fake-baseline"],
          synthesizer: byId["fake-baseline"],
        },
        taskInputTokens: 1000,
        reviewCall: false,
        webToolsEnabled: true,
      },
      context
    )
    // 2 members × 2 calls + judge 2 (+evidence) + synth 1 + final verify 1
    expect(estimate.modelCalls).toBe(8)
    expect(estimate.stageReserveMicrousd).toBeGreaterThan(0)
    expect(estimate.stageReserveMicrousd).toBeLessThan(estimate.reserveMicrousd)
    // Parallel members: latency counts the slowest member once, plus the tail.
    expect(estimate.p95Ms).toBe(Math.max(400 * 2, 700 * 2) + 900 * 3 + 900)
  })

  it("bounds delegate calls by the worker turn and takeover limits", () => {
    const calls = plannedCalls({
      mode: "delegate",
      extension: defaultExtension("delegate"),
      roles: { lead: byId["fake-baseline"], worker: byId["fake-economy"] },
      taskInputTokens: 500,
      reviewCall: false,
      webToolsEnabled: false,
    })
    expect(calls.map((c) => [c.role, c.calls, c.stage])).toEqual([
      ["lead", 1, false],
      ["worker", 8, false],
      ["lead", 2, true],
    ])
  })

  it("adds a review call for direct text_review and assumes cascade escalation", () => {
    const direct = plannedCalls({
      mode: "direct",
      extension: defaultExtension("direct"),
      roles: { solver: byId["fake-baseline"] },
      taskInputTokens: 100,
      reviewCall: true,
      webToolsEnabled: false,
    })
    expect(direct.map((c) => c.role)).toEqual(["solver", "solver"])
    const cascade = estimateAction(
      {
        mode: "cascade",
        extension: defaultExtension("cascade"),
        roles: { cheap: byId["fake-economy"], strong: byId["fake-baseline"] },
        taskInputTokens: 100,
        reviewCall: false,
        webToolsEnabled: false,
      },
      context
    )
    expect(cascade.modelCalls).toBe(2)
    expect(cascade.p95Ms).toBe(400 + 900)
    expect(cascade.priceKnown).toBe(true)
  })

  it("reserves a reviewed cascade's two review calls, on the reviewer or the strong deployment", () => {
    const shape = {
      mode: "cascade" as const,
      extension: defaultExtension("cascade"),
      roles: { cheap: byId["fake-economy"], strong: byId["fake-baseline"] },
      taskInputTokens: 100,
      webToolsEnabled: false,
    }
    const unreviewed = estimateAction({ ...shape, reviewCall: false }, context)
    const reviewed = estimateAction({ ...shape, reviewCall: true }, context)
    expect(plannedCalls({ ...shape, reviewCall: true }).map((c) => [c.role, c.calls])).toEqual([
      ["cheap", 1],
      ["strong", 1],
      ["strong", 2],
    ])
    expect(reviewed.modelCalls).toBe(4)
    expect(reviewed.reserveMicrousd).toBeGreaterThan(unreviewed.reserveMicrousd)
    expect(reviewed.p95Ms).toBe(400 + 900 * 3)

    const withReviewer = plannedCalls({
      ...shape,
      roles: { ...shape.roles, reviewer: byId["fake-economy"] },
      reviewCall: true,
    })
    expect(withReviewer.at(-1)).toMatchObject({ role: "reviewer", calls: 2 })
  })
})
