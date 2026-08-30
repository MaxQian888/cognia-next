import {
  evaluatorConfigDigest,
  isCalibratedJudge,
  normalizeEvaluatorConfig,
  validateEvaluatorSpec,
  type EvaluatorConfig,
  type EvaluatorSpecV1,
} from "./evaluator-spec"

function spec(overrides: Partial<EvaluatorSpecV1> = {}): EvaluatorSpecV1 {
  return {
    schema: "cognia-evaluator/v1",
    id: "ev",
    versionId: "ev@1",
    kind: "built-in",
    dimension: "tool-use",
    gating: true,
    configDigest: "sha256:abc",
    config: { kind: "built-in", scorerId: "tool-selection" },
    createdAt: 0,
    ...overrides,
  }
}

describe("normalizeEvaluatorConfig", () => {
  it("is stable under property reordering, so a reserialize is not an edit", () => {
    const a = { kind: "rule", mode: "numeric", grading: { mode: "numeric", tolerance: 0.1 } }
    const b = { grading: { tolerance: 0.1, mode: "numeric" }, mode: "numeric", kind: "rule" }
    expect(normalizeEvaluatorConfig(a as EvaluatorConfig)).toBe(
      normalizeEvaluatorConfig(b as EvaluatorConfig)
    )
  })

  it("does NOT reorder arrays, where position is meaning", () => {
    const forward = { kind: "llm-rubric", labels: ["a", "b"] } as unknown as EvaluatorConfig
    const reverse = { kind: "llm-rubric", labels: ["b", "a"] } as unknown as EvaluatorConfig
    expect(normalizeEvaluatorConfig(forward)).not.toBe(normalizeEvaluatorConfig(reverse))
  })
})

describe("evaluatorConfigDigest", () => {
  it("gives the same digest for the same config and a different one otherwise", async () => {
    const base: EvaluatorConfig = { kind: "built-in", scorerId: "tool-selection" }
    const same: EvaluatorConfig = { kind: "built-in", scorerId: "tool-selection" }
    const other: EvaluatorConfig = { kind: "built-in", scorerId: "tool-args" }
    const digest = await evaluatorConfigDigest(base)
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await evaluatorConfigDigest(same)).toBe(digest)
    expect(await evaluatorConfigDigest(other)).not.toBe(digest)
  })
})

describe("validateEvaluatorSpec", () => {
  it("accepts a well-formed built-in evaluator", () => {
    expect(validateEvaluatorSpec(spec())).toEqual([])
  })

  it("rejects a built-in naming a scorer the catalog does not have", () => {
    // Guards the drift the catalog itself was introduced to stop — an
    // evaluator pinned to `redundancy` instead of the real `tool-redundancy`
    // would silently grade nothing.
    const problems = validateEvaluatorSpec(
      spec({ config: { kind: "built-in", scorerId: "redundancy" } })
    )
    expect(problems.join(" ")).toContain("unknown built-in scorer")
  })

  it("catches a kind that disagrees with its config", () => {
    expect(validateEvaluatorSpec(spec({ kind: "rule" })).join(" ")).toContain("does not match")
  })

  it("requires a real digest, not a placeholder", () => {
    expect(validateEvaluatorSpec(spec({ configDigest: "abc" })).join(" ")).toContain("sha256")
  })

  it("holds rule evaluators to the fields their mode actually needs", () => {
    expect(
      validateEvaluatorSpec(
        spec({ kind: "rule", config: { kind: "rule", mode: "json-pointer" } })
      ).join(" ")
    ).toContain("RFC 6901")
    expect(
      validateEvaluatorSpec(
        spec({ kind: "rule", config: { kind: "rule", mode: "cost-budget", maxCostUsd: 0 } })
      ).join(" ")
    ).toContain("positive maxCostUsd")
    expect(
      validateEvaluatorSpec(spec({ kind: "rule", config: { kind: "rule", mode: "regex" } })).join(
        " "
      )
    ).toContain("grading pattern")
  })

  it("requires a rubric judge to state its criterion, rubric, and prompt digest", () => {
    const problems = validateEvaluatorSpec(
      spec({
        kind: "llm-rubric",
        config: { kind: "llm-rubric", criterion: " ", rubric: "", promptDigest: "x", judge: {} },
      })
    )
    expect(problems.join(" ")).toContain("criterion")
    expect(problems.join(" ")).toContain("rubric")
    expect(problems.join(" ")).toContain("promptDigest")
  })

  it("returns reasons rather than a bare boolean", () => {
    const problems = validateEvaluatorSpec(spec({ id: "", versionId: "" }))
    expect(problems).toContain("id is required")
    expect(problems).toContain("versionId is required")
  })
})

describe("isCalibratedJudge", () => {
  const judge = (calibrationRef?: { runId: string; kappa: number; accuracy: number }) =>
    spec({
      kind: "llm-rubric",
      config: {
        kind: "llm-rubric",
        criterion: "c",
        rubric: "r",
        promptDigest: "sha256:x",
        judge: {},
        ...(calibrationRef ? { calibrationRef } : {}),
      },
    })

  it("treats an uncalibrated judge as uncalibrated rather than assuming the best", () => {
    expect(isCalibratedJudge(judge())).toBe(false)
  })

  it("applies ADR-0101's κ ≥ 0.6 and accuracy ≥ 0.8 bar", () => {
    expect(isCalibratedJudge(judge({ runId: "r", kappa: 0.6, accuracy: 0.8 }))).toBe(true)
    expect(isCalibratedJudge(judge({ runId: "r", kappa: 0.59, accuracy: 0.9 }))).toBe(false)
    expect(isCalibratedJudge(judge({ runId: "r", kappa: 0.9, accuracy: 0.79 }))).toBe(false)
  })

  it("does not demand calibration from evaluators that use no judge", () => {
    expect(isCalibratedJudge(spec())).toBe(true)
  })
})
