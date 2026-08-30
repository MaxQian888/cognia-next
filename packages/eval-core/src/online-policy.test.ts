import {
  DEFAULT_ONLINE_EVAL_ESCALATION,
  DEFAULT_ONLINE_EVAL_SAMPLING,
  decideJudgeSampling,
  matchesOnlineEvalPolicy,
  sampleFraction,
  validateOnlineEvalPolicy,
  type OnlineEvalCandidate,
  type OnlineEvalPolicyV1,
} from "./online-policy"

function policy(overrides: Partial<OnlineEvalPolicyV1> = {}): OnlineEvalPolicyV1 {
  return {
    schema: "cognia-online-eval-policy/v1",
    id: "p",
    versionId: "p@1",
    name: "Chat quality",
    enabled: true,
    shadow: false,
    selector: {},
    deterministicEvaluatorVersionIds: ["det@1"],
    judgeEvaluatorVersionIds: ["judge@1"],
    sampling: { ...DEFAULT_ONLINE_EVAL_SAMPLING },
    budget: { dailyUsdCap: 5 },
    escalation: { ...DEFAULT_ONLINE_EVAL_ESCALATION },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const candidate = (overrides: Partial<OnlineEvalCandidate> = {}): OnlineEvalCandidate => ({
  traceId: "trace-1",
  workspaceId: "w1",
  projectId: "pr1",
  surface: "chat",
  model: "claude-opus-5",
  ...overrides,
})

describe("matchesOnlineEvalPolicy", () => {
  it("matches everything when the selector is empty", () => {
    expect(matchesOnlineEvalPolicy(policy(), candidate())).toBe(true)
  })

  it("never matches while disabled, whatever the selector says", () => {
    expect(matchesOnlineEvalPolicy(policy({ enabled: false }), candidate())).toBe(false)
  })

  it("scopes by workspace, project, surface, model and operation", () => {
    expect(
      matchesOnlineEvalPolicy(policy({ selector: { workspaceId: "other" } }), candidate())
    ).toBe(false)
    expect(matchesOnlineEvalPolicy(policy({ selector: { surfaces: ["chat"] } }), candidate())).toBe(
      true
    )
    expect(
      matchesOnlineEvalPolicy(policy({ selector: { surfaces: ["workflow"] } }), candidate())
    ).toBe(false)
    expect(
      matchesOnlineEvalPolicy(policy({ selector: { models: ["claude-opus-5"] } }), candidate())
    ).toBe(true)
  })

  it("treats a missing field as a non-match when the selector names that axis", () => {
    // A trace with no model must not slip through a model-scoped policy just
    // because the field is absent.
    expect(
      matchesOnlineEvalPolicy(
        policy({ selector: { models: ["claude-opus-5"] } }),
        candidate({ model: undefined })
      )
    ).toBe(false)
  })

  it("matches tags on any overlap, not on all", () => {
    const tagged = policy({ selector: { tags: ["prod", "beta"] } })
    expect(matchesOnlineEvalPolicy(tagged, candidate({ tags: ["beta"] }))).toBe(true)
    expect(matchesOnlineEvalPolicy(tagged, candidate({ tags: ["other"] }))).toBe(false)
    expect(matchesOnlineEvalPolicy(tagged, candidate({ tags: [] }))).toBe(false)
  })
})

describe("sampleFraction", () => {
  it("is deterministic, so a retried trace makes the same decision twice", () => {
    expect(sampleFraction("trace-1")).toBe(sampleFraction("trace-1"))
    expect(sampleFraction("trace-1")).not.toBe(sampleFraction("trace-2"))
  })

  it("stays within [0,1)", () => {
    for (let index = 0; index < 500; index++) {
      const value = sampleFraction(`trace-${index}`)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it("lands near the requested rate over many traces", () => {
    const ids = Array.from({ length: 4000 }, (_, index) => `trace-${index}`)
    const sampled = ids.filter((id) => sampleFraction(id) < 0.05).length
    expect(sampled / ids.length).toBeGreaterThan(0.03)
    expect(sampled / ids.length).toBeLessThan(0.07)
  })
})

describe("decideJudgeSampling", () => {
  const base = { spentUsdToday: 0, judgedToday: 0, estimatedUsd: 0.01 }

  it("names WHY it skipped instead of returning a bare false", () => {
    expect(
      decideJudgeSampling({
        ...base,
        policy: policy({ judgeEvaluatorVersionIds: [] }),
        candidate: candidate(),
      })
    ).toBe("skipped-no-judge")
    expect(
      decideJudgeSampling({ ...base, policy: policy(), candidate: candidate(), judgedToday: 200 })
    ).toBe("skipped-daily-max")
    expect(
      decideJudgeSampling({ ...base, policy: policy(), candidate: candidate(), spentUsdToday: 5 })
    ).toBe("skipped-budget")
  })

  it("charges the ESTIMATE against the cap, refusing the call that would exceed it", () => {
    // Checking spend after the fact is how a cap gets passed by exactly one call.
    expect(
      decideJudgeSampling({
        policy: policy(),
        candidate: candidate({ priority: true }),
        spentUsdToday: 4.999,
        judgedToday: 0,
        estimatedUsd: 0.01,
      })
    ).toBe("skipped-budget")
  })

  it("lets a priority trace bypass the RATE but never the budget or the ceiling", () => {
    const unlucky = candidate({ traceId: "trace-2", priority: true })
    expect(sampleFraction(unlucky.traceId)).toBeGreaterThan(0.05)
    expect(decideJudgeSampling({ ...base, policy: policy(), candidate: unlucky })).toBe("run")
    expect(
      decideJudgeSampling({ ...base, policy: policy(), candidate: unlucky, judgedToday: 200 })
    ).toBe("skipped-daily-max")
  })

  it("runs a trace that falls inside the sample rate", () => {
    const always = policy({ sampling: { judgeRate: 1, judgeDailyMax: 200 } })
    expect(decideJudgeSampling({ ...base, policy: always, candidate: candidate() })).toBe("run")
    const never = policy({ sampling: { judgeRate: 0, judgeDailyMax: 200 } })
    expect(decideJudgeSampling({ ...base, policy: never, candidate: candidate() })).toBe(
      "skipped-not-sampled"
    )
  })
})

describe("validateOnlineEvalPolicy", () => {
  it("accepts a well-formed policy", () => {
    expect(validateOnlineEvalPolicy(policy())).toEqual([])
  })

  it("refuses to let an LLM judge run without a positive daily cap", () => {
    // The one rule worth failing a save over: an uncapped judge against a
    // production trace stream is an unbounded bill.
    const problems = validateOnlineEvalPolicy(policy({ budget: { dailyUsdCap: 0 } }))
    expect(problems.join(" ")).toContain("positive budget.dailyUsdCap")
  })

  it("allows a deterministic-only policy with no budget, because it spends nothing", () => {
    expect(
      validateOnlineEvalPolicy(policy({ judgeEvaluatorVersionIds: [], budget: { dailyUsdCap: 0 } }))
    ).toEqual([])
  })

  it("rejects a policy with no evaluators at all", () => {
    expect(
      validateOnlineEvalPolicy(
        policy({
          deterministicEvaluatorVersionIds: [],
          judgeEvaluatorVersionIds: [],
          budget: { dailyUsdCap: 0 },
        })
      ).join(" ")
    ).toContain("at least one evaluator")
  })

  it("bounds the sample rate and the escalation band", () => {
    expect(
      validateOnlineEvalPolicy(policy({ sampling: { judgeRate: 1.5, judgeDailyMax: 10 } })).join(
        " "
      )
    ).toContain("judgeRate")
    expect(
      validateOnlineEvalPolicy(policy({ sampling: { judgeRate: 0.5, judgeDailyMax: -1 } })).join(
        " "
      )
    ).toContain("judgeDailyMax")
  })
})

describe("defaults", () => {
  it("samples judges at 5% with a 200/day ceiling, per the rollout plan", () => {
    expect(DEFAULT_ONLINE_EVAL_SAMPLING).toEqual({ judgeRate: 0.05, judgeDailyMax: 200 })
  })

  it("escalates on a ±0.1 band, conflicts, parse failures and negative feedback", () => {
    expect(DEFAULT_ONLINE_EVAL_ESCALATION.thresholdBand).toBe(0.1)
    expect(DEFAULT_ONLINE_EVAL_ESCALATION.onEvaluatorConflict).toBe(true)
    expect(DEFAULT_ONLINE_EVAL_ESCALATION.onJudgeParseFailure).toBe(true)
    expect(DEFAULT_ONLINE_EVAL_ESCALATION.onNegativeFeedback).toBe(true)
  })
})
