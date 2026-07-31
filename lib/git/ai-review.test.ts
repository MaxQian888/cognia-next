import {
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  generateDiffReview,
  salvageFindingsArray,
} from "./ai-review"

const file = { path: "src/a.ts", status: "modified" as const }

describe("buildReviewSystemPrompt", () => {
  it("asks for a JSON array of findings and the severity vocabulary", () => {
    const p = buildReviewSystemPrompt({})
    expect(p).toContain("JSON array")
    expect(p).toContain('"severity"')
    expect(p).toContain("critical")
  })

  it("appends custom instructions when present, and omits when blank", () => {
    expect(buildReviewSystemPrompt({ customInstructions: "focus on perf" })).toContain(
      "Additional instructions: focus on perf"
    )
    expect(buildReviewSystemPrompt({ customInstructions: "  " })).not.toContain(
      "Additional instructions"
    )
  })
})

describe("buildReviewUserPrompt", () => {
  it("numbers hunks and includes each patch in a fenced block", () => {
    const prompt = buildReviewUserPrompt({
      file,
      hunks: [{ patch: "@@ -1 +1 @@\n-a\n+b" }, { patch: "@@ -9 +9 @@\n-c\n+d" }],
      config: {},
    })
    expect(prompt).toContain("File: src/a.ts (modified)")
    expect(prompt).toContain("### Hunk 1")
    expect(prompt).toContain("### Hunk 2")
    expect(prompt).toContain("+b")
    expect(prompt).toContain("+d")
  })
})

describe("generateDiffReview", () => {
  it("returns [] without calling the model when there are no hunks", async () => {
    const complete = jest.fn()
    const out = await generateDiffReview({ file, hunks: [], config: {} }, { complete })
    expect(out).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it("parses + normalizes findings from a JSON array response", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(
        '[{"hunk":1,"severity":"critical","note":"null deref"},{"hunk":2,"severity":"info","note":"nit"}]'
      )
    const out = await generateDiffReview(
      { file, hunks: [{ patch: "p1" }, { patch: "p2" }], config: {} },
      { complete }
    )
    expect(out).toEqual([
      { hunk: 1, severity: "critical", note: "null deref" },
      { hunk: 2, severity: "info", note: "nit" },
    ])
  })

  it("extracts JSON even when wrapped in prose/fences", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(
        'Here you go:\n```json\n[{"hunk":1,"severity":"warning","note":"leak"}]\n```'
      )
    const out = await generateDiffReview(
      { file, hunks: [{ patch: "p" }], config: {} },
      { complete }
    )
    expect(out).toEqual([{ hunk: 1, severity: "warning", note: "leak" }])
  })

  it("defaults unknown severity to info and drops out-of-range/empty findings", async () => {
    const complete = jest.fn().mockResolvedValue(
      JSON.stringify([
        { hunk: 1, severity: "bogus", note: "keep" },
        { hunk: 9, severity: "info", note: "out of range" },
        { hunk: 1, severity: "info", note: "duplicate hunk dropped" },
        { hunk: 1, severity: "info", note: "   " },
      ])
    )
    const out = await generateDiffReview(
      { file, hunks: [{ patch: "p1" }], config: {} },
      { complete }
    )
    expect(out).toEqual([{ hunk: 1, severity: "info", note: "keep" }])
  })

  it("degrades to [] on non-JSON / non-array output", async () => {
    const complete = jest.fn().mockResolvedValue("no findings, looks good")
    const out = await generateDiffReview(
      { file, hunks: [{ patch: "p" }], config: {} },
      { complete }
    )
    expect(out).toEqual([])
  })

  it("degrades to [] when the response is a JSON object, not an array", async () => {
    const complete = jest.fn().mockResolvedValue('{"hunk":1,"severity":"info","note":"x"}')
    const out = await generateDiffReview(
      { file, hunks: [{ patch: "p" }], config: {} },
      { complete }
    )
    expect(out).toEqual([])
  })

  it("salvages complete findings when the response is truncated mid-array", async () => {
    // Model output cut off by the token cap partway through the 3rd object —
    // extractJson would throw on the unterminated span; salvage must keep #1/#2.
    const truncated =
      '[{"hunk":1,"severity":"critical","note":"a"},' +
      '{"hunk":2,"severity":"warning","note":"b"},' +
      '{"hunk":3,"severity":"info","not'
    const complete = jest.fn().mockResolvedValue(truncated)
    const out = await generateDiffReview(
      { file, hunks: [{ patch: "p1" }, { patch: "p2" }, { patch: "p3" }], config: {} },
      { complete }
    )
    expect(out).toEqual([
      { hunk: 1, severity: "critical", note: "a" },
      { hunk: 2, severity: "warning", note: "b" },
    ])
  })

  it("scales maxTokens with hunk count (above the old 800 cap, bounded at 4096)", async () => {
    const complete = jest.fn().mockResolvedValue("[]")
    await generateDiffReview(
      { file, hunks: Array.from({ length: 20 }, () => ({ patch: "p" })), config: {} },
      { complete }
    )
    expect(complete.mock.calls[0][1].maxTokens).toBeGreaterThan(800)
    complete.mockClear()
    await generateDiffReview(
      { file, hunks: Array.from({ length: 200 }, () => ({ patch: "p" })), config: {} },
      { complete }
    )
    expect(complete.mock.calls[0][1].maxTokens).toBe(4096)
  })
})

describe("salvageFindingsArray", () => {
  it("recovers complete objects from a truncated array and skips the partial tail", () => {
    expect(salvageFindingsArray('[{"a":1},{"b":2},{"c')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it("ignores braces inside string literals", () => {
    expect(salvageFindingsArray('[{"note":"has } brace"},{"x')).toEqual([{ note: "has } brace" }])
  })

  it("returns [] when there is no array bracket", () => {
    expect(salvageFindingsArray("nope")).toEqual([])
  })

  it("stops at the array close and ignores trailing prose", () => {
    expect(salvageFindingsArray('[{"a":1}] and some trailing text')).toEqual([{ a: 1 }])
  })
})
