import type { TraceAnnotationRow } from "@/lib/db/trace-annotations"
import { buildFailureTaxonomy, saturationReached, suggestEvalCandidates } from "./coding"

function ann(
  traceId: string,
  failureMode: string | undefined,
  createdAt: number
): TraceAnnotationRow {
  return {
    id: "an_" + traceId,
    traceId,
    sessionId: "s",
    firstFailureNote: "note",
    ...(failureMode ? { failureMode } : {}),
    createdAt,
    updatedAt: createdAt,
  }
}

describe("buildFailureTaxonomy", () => {
  it("rolls up counts per failure mode, sorted by frequency", () => {
    const taxonomy = buildFailureTaxonomy([
      ann("t1", "wrong-tool", 1),
      ann("t2", "wrong-tool", 2),
      ann("t3", "hallucination", 3),
      ann("t4", "wrong-tool", 4),
    ])
    expect(taxonomy[0]).toMatchObject({ failureMode: "wrong-tool", count: 3 })
    expect(taxonomy[1]).toMatchObject({ failureMode: "hallucination", count: 1 })
    expect(taxonomy[0].traceIds).toEqual(["t1", "t2", "t4"])
  })

  it("buckets unlabeled annotations under (unlabeled)", () => {
    const taxonomy = buildFailureTaxonomy([ann("t1", undefined, 1)])
    expect(taxonomy[0]).toMatchObject({ failureMode: "(unlabeled)", count: 1 })
  })
})

describe("saturationReached", () => {
  it("is false while new failure modes keep appearing", () => {
    const annotations = [ann("t1", "a", 1), ann("t2", "b", 2), ann("t3", "c", 3)]
    expect(saturationReached(annotations, 2)).toBe(false)
  })

  it("is true when the last window introduced no new failure mode", () => {
    const annotations = [ann("t1", "a", 1), ann("t2", "b", 2), ann("t3", "a", 3), ann("t4", "b", 4)]
    expect(saturationReached(annotations, 2)).toBe(true)
  })

  it("is false when there are fewer annotations than the window", () => {
    expect(saturationReached([ann("t1", "a", 1)], 5)).toBe(false)
  })
})

describe("suggestEvalCandidates", () => {
  it("returns failure modes at or above the minimum count, frequency-ordered", () => {
    const taxonomy = buildFailureTaxonomy([
      ann("t1", "wrong-tool", 1),
      ann("t2", "wrong-tool", 2),
      ann("t3", "rare", 3),
    ])
    expect(suggestEvalCandidates(taxonomy, 2).map((c) => c.failureMode)).toEqual(["wrong-tool"])
  })

  it("excludes the (unlabeled) bucket from candidates", () => {
    const taxonomy = buildFailureTaxonomy([ann("t1", undefined, 1), ann("t2", undefined, 2)])
    expect(suggestEvalCandidates(taxonomy, 1)).toHaveLength(0)
  })
})
