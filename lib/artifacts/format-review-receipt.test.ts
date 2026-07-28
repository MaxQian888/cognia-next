import { formatReviewReceiptsForLLM } from "./format-review-receipt"
import type { ArtifactReviewReceipt } from "@/types/artifact/artifact"

const receipt = (over: Partial<ArtifactReviewReceipt> = {}): ArtifactReviewReceipt => ({
  sessionId: "s1",
  artifactId: "a1",
  title: "pipeline.ts",
  outcome: "rejected",
  accepted: 0,
  total: 3,
  ...over,
})

describe("formatReviewReceiptsForLLM", () => {
  it("returns an empty string with nothing to report", () => {
    expect(formatReviewReceiptsForLLM([])).toBe("")
  })

  it("names the artifact and states the artifact is unchanged on rejection", () => {
    const out = formatReviewReceiptsForLLM([receipt()])
    expect(out).toContain('"pipeline.ts"')
    expect(out).toContain("rejected")
    expect(out).toContain("unchanged")
  })

  it("pluralises a single rejected change", () => {
    expect(formatReviewReceiptsForLLM([receipt({ total: 1 })])).toContain("(1 change)")
    expect(formatReviewReceiptsForLLM([receipt({ total: 2 })])).toContain("(2 changes)")
  })

  it("reports a full acceptance as such", () => {
    const out = formatReviewReceiptsForLLM([receipt({ outcome: "applied", accepted: 3, total: 3 })])
    expect(out).toContain("in full (3/3)")
  })

  // The interesting case: a partial acceptance is the signal the model was
  // missing entirely, and it must not read as a plain "applied".
  it("reports a partial acceptance with both counts", () => {
    const out = formatReviewReceiptsForLLM([receipt({ outcome: "applied", accepted: 2, total: 5 })])
    expect(out).toContain("accepted 2 of 5")
    expect(out).toContain("discarded the rest")
    expect(out).not.toContain("in full")
  })

  // Applying with every hunk left pending changes nothing on disk, so calling
  // it "applied" would tell the model its proposal landed when it did not.
  it("treats an apply that kept nothing as unchanged, not as applied", () => {
    const out = formatReviewReceiptsForLLM([receipt({ outcome: "applied", accepted: 0, total: 4 })])
    expect(out).toContain("kept none of the 4")
    expect(out).toContain("unchanged")
    expect(out).not.toContain("accepted 0 of 4")
  })

  it("lists every receipt under one instruction header", () => {
    const out = formatReviewReceiptsForLLM([
      receipt({ artifactId: "a1", title: "one" }),
      receipt({ artifactId: "a2", title: "two", outcome: "applied", accepted: 1, total: 1 }),
    ])
    expect(out.startsWith("Outcome of your previous revision proposal(s)")).toBe(true)
    expect(out).toContain('"one"')
    expect(out).toContain('"two"')
    // One header, two bullets.
    expect(out.split("\n")).toHaveLength(3)
  })
})
