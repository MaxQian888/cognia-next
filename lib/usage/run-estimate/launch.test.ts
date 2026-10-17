jest.mock("./load-samples", () => ({ loadRunEstimateContext: jest.fn() }))

import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"

import { EMPTY_ESTIMATE, type RunSample } from "./estimate"
import { estimateLaunch, estimateLaunchNow, prepareQuery } from "./launch"
import { loadRunEstimateContext } from "./load-samples"

const loadMock = loadRunEstimateContext as jest.Mock

const NOW = 1_800_000_000_000
const resolvePreset = (id: string) => (id === "cfg" ? "codex" : undefined)

function sample(over: Partial<RunSample> = {}): RunSample {
  return {
    surface: "best-of-n",
    harness: "builtin",
    modelFamily: "claude-sonnet",
    endedAt: NOW - 1000,
    durationMs: 60_000,
    tokens: null,
    frozenCostUsd: 1,
    stoppedEarly: false,
    ...over,
  }
}

describe("prepareQuery", () => {
  it("derives family from the model and harness from the provider", () => {
    expect(
      prepareQuery(
        { surface: "goal", model: "claude-sonnet-4-5", providerId: "anthropic" },
        resolvePreset
      )
    ).toEqual({
      surface: "goal",
      model: "claude-sonnet-4-5",
      providerId: "anthropic",
      modelFamily: "claude-sonnet",
      harness: "builtin",
    })
    expect(
      prepareQuery({ surface: "goal", providerId: externalAgentProviderId("cfg") }, resolvePreset)
        .harness
    ).toBe("ext:codex")
  })

  it("keeps an explicit harness, including unknown", () => {
    expect(
      prepareQuery({ surface: "team", harness: null, providerId: "x" }, resolvePreset).harness
    ).toBeNull()
    expect(prepareQuery({ surface: "team", harness: "mixed" }, resolvePreset).harness).toBe("mixed")
  })

  it("leaves harness undefined with no provider to derive it from", () => {
    expect("harness" in prepareQuery({ surface: "goal" }, resolvePreset)).toBe(false)
    expect(prepareQuery({ surface: "goal" }, resolvePreset).modelFamily).toBeNull()
  })
})

describe("estimateLaunch", () => {
  const context = {
    samples: [
      ...Array.from({ length: 5 }, () => sample()),
      ...Array.from({ length: 5 }, () => sample({ harness: "ext:codex", frozenCostUsd: 3 })),
    ],
    resolvePreset,
  }

  it("estimates one part directly", () => {
    const est = estimateLaunch(
      [{ surface: "best-of-n", providerId: "anthropic", multiplier: 2 }],
      context,
      NOW
    )
    expect(est.costUsd?.p50).toBeCloseTo(2)
  })

  it("sums parallel parts on different harnesses", () => {
    const est = estimateLaunch(
      [
        { surface: "best-of-n", providerId: "anthropic", multiplier: 2 },
        { surface: "best-of-n", providerId: externalAgentProviderId("cfg"), multiplier: 1 },
      ],
      context,
      NOW
    )
    expect(est.costUsd?.p50).toBeCloseTo(5)
  })

  it("is empty with no queries", () => {
    expect(estimateLaunch([], context, NOW)).toEqual(EMPTY_ESTIMATE)
  })
})

describe("estimateLaunchNow", () => {
  it("estimates against the loaded context", async () => {
    loadMock.mockResolvedValue({
      samples: [sample(), sample(), sample(), sample(), sample()],
      resolvePreset,
    })
    const est = await estimateLaunchNow([{ surface: "best-of-n", providerId: "anthropic" }], NOW)
    expect(loadMock).toHaveBeenCalledWith({ now: NOW })
    expect(est.confidence).toBe("few")
  })
})
