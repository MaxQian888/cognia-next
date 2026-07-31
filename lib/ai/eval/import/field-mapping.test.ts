import { mapRowsToCases } from "./field-mapping"

let counter = 0
const deps = {
  datasetId: "d",
  capability: "chat",
  now: () => 1000,
  id: () => `evc_${counter++}`,
}
beforeEach(() => {
  counter = 0
})

describe("mapRowsToCases", () => {
  it("maps a single input column + expected to a case", () => {
    const out = mapRowsToCases(
      { columns: ["q", "a"], rows: [{ q: "hi", a: "yo" }] },
      { input: "q", expected: "a" },
      deps
    )
    expect(out.cases).toHaveLength(1)
    expect(out.cases[0].input).toBe("hi")
    expect(out.cases[0].reference?.expectedOutput).toBe("yo")
    expect(out.cases[0].source).toBe("handwritten")
    expect(out.cases[0].capability).toBe("chat")
    expect(out.cases[0].datasetId).toBe("d")
  })

  it("combines multiple input columns as JSON into inputVars", () => {
    const out = mapRowsToCases(
      { columns: ["a", "b"], rows: [{ a: "1", b: "2" }] },
      { input: ["a", "b"], combine: "json" },
      deps
    )
    expect(out.cases[0].inputVars).toEqual({ a: "1", b: "2" })
    expect(JSON.parse(out.cases[0].input)).toEqual({ a: "1", b: "2" })
  })

  it("concatenates multiple input columns by default", () => {
    const out = mapRowsToCases(
      { columns: ["a", "b"], rows: [{ a: "1", b: "2" }] },
      { input: ["a", "b"] },
      deps
    )
    expect(out.cases[0].input).toBe("1\n2")
    expect(out.cases[0].inputVars).toBeUndefined()
  })

  it("maps an array expected to expectedContains", () => {
    const out = mapRowsToCases(
      { columns: ["q", "x", "y"], rows: [{ q: "hi", x: "foo", y: "bar" }] },
      { input: "q", expected: ["x", "y"] },
      deps
    )
    expect(out.cases[0].reference?.expectedContains).toEqual(["foo", "bar"])
  })

  it("copies metadata columns and uses an explicit id column", () => {
    const out = mapRowsToCases(
      { columns: ["q", "lbl", "cid"], rows: [{ q: "hi", lbl: "easy", cid: "case-7" }] },
      { input: "q", id: "cid", metadata: ["lbl"] },
      deps
    )
    expect(out.cases[0].id).toBe("case-7")
    expect(out.cases[0].metadata).toEqual({ lbl: "easy" })
  })

  it("serializes non-string cells", () => {
    const out = mapRowsToCases(
      { columns: ["q"], rows: [{ q: { nested: true } }] },
      { input: "q" },
      deps
    )
    expect(out.cases[0].input).toBe('{"nested":true}')
  })

  it("skips rows with empty input and records the reason", () => {
    const out = mapRowsToCases(
      { columns: ["q"], rows: [{ q: "" }, { q: "ok" }] },
      { input: "q" },
      deps
    )
    expect(out.cases).toHaveLength(1)
    expect(out.skipped).toEqual([{ row: 0, reason: "empty input" }])
  })

  it("falls back to a generated id when the id column is blank", () => {
    const out = mapRowsToCases(
      { columns: ["q", "cid"], rows: [{ q: "hi", cid: "" }] },
      { input: "q", id: "cid" },
      deps
    )
    expect(out.cases[0].id).toMatch(/^evc_/)
  })
})

describe("mapRowsToCases — split, grading and provenance", () => {
  const rows = { columns: ["q", "a", "s"], rows: [{ q: "hi", a: "yo", s: "validation" }] }

  it("writes a literal split onto every case", () => {
    // Nothing used to write `split` at all, so `CaseSubset.split` — wired end to
    // end everywhere else — could never match an imported case.
    const out = mapRowsToCases(rows, { input: "q", splitLiteral: "test" }, deps)
    expect(out.cases[0].split).toBe("test")
  })

  it("prefers a mapped split column over the literal", () => {
    const out = mapRowsToCases(rows, { input: "q", split: "s", splitLiteral: "test" }, deps)
    expect(out.cases[0].split).toBe("validation")
  })

  it("falls back to the literal when the split column is blank on a row", () => {
    const out = mapRowsToCases(
      { columns: ["q", "s"], rows: [{ q: "hi", s: "" }] },
      { input: "q", split: "s", splitLiteral: "test" },
      deps
    )
    expect(out.cases[0].split).toBe("test")
  })

  it("omits split entirely when neither is given", () => {
    expect(mapRowsToCases(rows, { input: "q" }, deps).cases[0]).not.toHaveProperty("split")
  })

  it("stamps the grading rule onto a single-column golden answer", () => {
    const out = mapRowsToCases(
      rows,
      { input: "q", expected: "a", grading: { mode: "exact", normalize: { stripArticles: true } } },
      deps
    )
    expect(out.cases[0].reference).toEqual({
      expectedOutput: "yo",
      grading: { mode: "exact", normalize: { stripArticles: true } },
    })
  })

  it("stamps the grading rule onto a multi-column alias set", () => {
    const out = mapRowsToCases(
      rows,
      { input: "q", expected: ["a", "s"], grading: { mode: "contains-any" } },
      deps
    )
    expect(out.cases[0].reference).toEqual({
      expectedContains: ["yo", "validation"],
      grading: { mode: "contains-any" },
    })
  })

  it("does not persist a grading rule with nothing to compare against", () => {
    const out = mapRowsToCases(rows, { input: "q", grading: { mode: "exact" } }, deps)
    expect(out.cases[0].reference).toBeUndefined()
  })

  it("records real provenance instead of labelling every import handwritten", () => {
    expect(mapRowsToCases(rows, { input: "q" }, deps).cases[0].source).toBe("handwritten")
    expect(
      mapRowsToCases(rows, { input: "q", sourceKind: "synthetic" }, deps).cases[0].source
    ).toBe("synthetic")
  })
})
