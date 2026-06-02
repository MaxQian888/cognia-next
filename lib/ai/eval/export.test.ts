import { toJsonl, toCsv } from "./export"
import { parseCsv } from "./import/parse-tabular"
import type { EvalCase } from "@/types/eval/eval"

function caseRow(over: Partial<EvalCase>): EvalCase {
  return {
    id: "c1",
    datasetId: "d",
    input: "hi",
    capability: "chat",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe("toJsonl", () => {
  it("emits one full-fidelity JSON object per line", () => {
    const out = toJsonl([caseRow({ id: "a" }), caseRow({ id: "b", tags: ["x"] })])
    const lines = out.split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).tags).toEqual(["x"])
  })
})

describe("toCsv", () => {
  it("projects the common columns with a header", () => {
    const csv = toCsv([
      caseRow({
        id: "a",
        input: "hello",
        reference: { expectedOutput: "world" },
        split: "test",
        tags: ["t1", "t2"],
      }),
    ])
    const parsed = parseCsv(csv)
    expect(parsed.columns).toEqual(["id", "input", "expectedOutput", "capability", "split", "tags"])
    expect(parsed.rows[0]).toEqual({
      id: "a",
      input: "hello",
      expectedOutput: "world",
      capability: "chat",
      split: "test",
      tags: "t1|t2",
    })
  })

  it("escapes commas / quotes / newlines (round-trips through parseCsv)", () => {
    const csv = toCsv([caseRow({ id: "a", input: 'has, "quote"\nand newline' })])
    const parsed = parseCsv(csv)
    expect(parsed.rows[0].input).toBe('has, "quote"\nand newline')
  })
})
