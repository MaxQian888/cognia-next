import {
  VERIFIER_LENSES,
  TOOL_REQUIRING_LENSES,
  findingSchema,
  findingsResultSchema,
  findingKey,
  verdictSchema,
  attemptSchema,
  judgeScoreSchema,
  critiqueResultSchema,
  synthesisReportSchema,
  ultracodeStageSchema,
  ultracodePlanSchema,
  ULTRACODE_PATTERN_KINDS,
  type Finding,
} from "./ultracode"

describe("ultracode lenses", () => {
  it("exposes the four canonical lenses", () => {
    expect(VERIFIER_LENSES).toEqual(["correctness", "security", "perf", "repro"])
  })

  it("marks only repro as tool-requiring", () => {
    expect(TOOL_REQUIRING_LENSES.has("repro")).toBe(true)
    expect(TOOL_REQUIRING_LENSES.has("correctness")).toBe(false)
    expect(TOOL_REQUIRING_LENSES.has("security")).toBe(false)
    expect(TOOL_REQUIRING_LENSES.has("perf")).toBe(false)
  })
})

describe("findingSchema", () => {
  it("accepts a minimal finding", () => {
    const parsed = findingSchema.parse({ title: "Bug", detail: "It breaks." })
    expect(parsed.title).toBe("Bug")
    expect(parsed.id).toBeUndefined()
  })

  it("accepts a full finding", () => {
    const parsed = findingSchema.parse({
      id: "f1",
      title: "SQL injection",
      detail: "Unsanitised input",
      location: "lib/db.ts:42",
      severity: "critical",
    })
    expect(parsed.severity).toBe("critical")
  })

  it("rejects empty title / detail", () => {
    expect(findingSchema.safeParse({ title: "", detail: "x" }).success).toBe(false)
    expect(findingSchema.safeParse({ title: "x", detail: "" }).success).toBe(false)
  })

  it("rejects an unknown severity", () => {
    expect(findingSchema.safeParse({ title: "x", detail: "y", severity: "blocker" }).success).toBe(
      false
    )
  })

  it("validates a findings result envelope", () => {
    const r = findingsResultSchema.parse({ findings: [{ title: "a", detail: "b" }] })
    expect(r.findings).toHaveLength(1)
    expect(findingsResultSchema.safeParse({ findings: "nope" }).success).toBe(false)
  })
})

describe("findingKey", () => {
  it("prefers a normalised location", () => {
    const a: Finding = { title: "T", detail: "d", location: "  LIB/Db.ts:42 " }
    expect(findingKey(a)).toBe("loc:lib/db.ts:42")
  })

  it("falls back to a normalised title when no location", () => {
    const a: Finding = { title: "  Race   Condition ", detail: "d" }
    expect(findingKey(a)).toBe("title:race condition")
  })

  it("collapses two whitespace-different titles to the same key", () => {
    expect(findingKey({ title: "A  B", detail: "x" })).toBe(
      findingKey({ title: "a b", detail: "y" })
    )
  })
})

describe("verdictSchema", () => {
  it("accepts a verdict with optional lens", () => {
    const v = verdictSchema.parse({ real: false, reasoning: "refuted", lens: "security" })
    expect(v.real).toBe(false)
    expect(v.lens).toBe("security")
  })

  it("rejects a non-boolean real", () => {
    expect(verdictSchema.safeParse({ real: "yes", reasoning: "x" }).success).toBe(false)
  })

  it("rejects an empty reasoning", () => {
    expect(verdictSchema.safeParse({ real: true, reasoning: "" }).success).toBe(false)
  })
})

describe("attemptSchema + judgeScoreSchema", () => {
  it("validates an attempt", () => {
    expect(attemptSchema.parse({ angle: "mvp", content: "do x" }).angle).toBe("mvp")
  })

  it("validates a score in range and rejects out-of-range", () => {
    expect(judgeScoreSchema.parse({ score: 7, rationale: "good" }).score).toBe(7)
    expect(judgeScoreSchema.safeParse({ score: 11, rationale: "x" }).success).toBe(false)
    expect(judgeScoreSchema.safeParse({ score: -1, rationale: "x" }).success).toBe(false)
  })
})

describe("critiqueResultSchema", () => {
  it("validates gaps with optional suggestedSearch", () => {
    const r = critiqueResultSchema.parse({
      gaps: [{ description: "missing perf angle", suggestedSearch: "profile hot path" }],
    })
    expect(r.gaps[0]?.suggestedSearch).toBe("profile hot path")
  })

  it("accepts an empty gaps array (nothing missing)", () => {
    expect(critiqueResultSchema.parse({ gaps: [] }).gaps).toEqual([])
  })
})

describe("synthesisReportSchema", () => {
  it("validates a report with citations", () => {
    const r = synthesisReportSchema.parse({ report: "summary", citations: ["lib/a.ts:1"] })
    expect(r.citations).toEqual(["lib/a.ts:1"])
  })

  it("rejects an empty report", () => {
    expect(synthesisReportSchema.safeParse({ report: "" }).success).toBe(false)
  })
})

describe("ultracode plan schemas", () => {
  it("lists the six pattern kinds in phase order", () => {
    expect(ULTRACODE_PATTERN_KINDS).toEqual([
      "multi-modal-sweep",
      "loop-until-dry",
      "adversarial-verify",
      "judge-panel",
      "completeness-critic",
      "synthesize",
    ])
  })

  it("validates a stage with count + variants", () => {
    const s = ultracodeStageSchema.parse({
      pattern: "adversarial-verify",
      instruction: "refute each finding",
      count: 3,
      variants: ["correctness", "repro"],
    })
    expect(s.count).toBe(3)
  })

  it("rejects a count above the concurrency ceiling", () => {
    expect(
      ultracodeStageSchema.safeParse({ pattern: "judge-panel", instruction: "x", count: 99 })
        .success
    ).toBe(false)
  })

  it("rejects an unknown pattern kind", () => {
    expect(ultracodeStageSchema.safeParse({ pattern: "nonsense", instruction: "x" }).success).toBe(
      false
    )
  })

  it("validates a full plan and rejects an empty stage list", () => {
    const plan = ultracodePlanSchema.parse({
      summary: "sweep then verify then synthesize",
      stages: [
        {
          pattern: "multi-modal-sweep",
          instruction: "find bugs",
          variants: ["by-file", "by-call"],
        },
        { pattern: "adversarial-verify", instruction: "refute", count: 3 },
        { pattern: "synthesize", instruction: "write report" },
      ],
    })
    expect(plan.stages).toHaveLength(3)
    expect(ultracodePlanSchema.safeParse({ summary: "x", stages: [] }).success).toBe(false)
  })
})
