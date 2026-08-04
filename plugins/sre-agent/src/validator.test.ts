import { LOG_EVIDENCE } from "./fixtures"
import { validateTimelineDraft } from "./validator"

describe("validateTimelineDraft", () => {
  it("rejects rows without evidence", () => {
    const result = validateTimelineDraft(
      {
        rows: [
          {
            time: "12:02:10",
            component: "gateway",
            event: "fallback happened",
            signals: [],
            evidenceIds: [],
            sources: ["logs"],
            confidence: 0.9,
            flags: ["fallback"],
          },
        ],
      },
      LOG_EVIDENCE
    )

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("row.evidence_missing")
  })

  it("rejects unknown evidence ids and uncited sources", () => {
    const result = validateTimelineDraft(
      {
        rows: [
          {
            time: "12:02:10",
            component: "gateway",
            event: "fallback happened",
            signals: [],
            evidenceIds: ["missing"],
            sources: ["trace"],
            confidence: 0.9,
            flags: ["fallback"],
          },
        ],
      },
      LOG_EVIDENCE
    )

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["row.evidence_unknown", "row.source_uncited"])
    )
  })

  it("rejects sensitive user-facing text", () => {
    const result = validateTimelineDraft(
      {
        rows: [
          {
            time: "12:02:10",
            component: "gateway",
            event: "api_key ak_789 was used",
            signals: [],
            evidenceIds: ["log_001"],
            sources: ["logs"],
            confidence: 0.9,
            flags: [],
          },
        ],
      },
      LOG_EVIDENCE
    )

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("row.sensitive_text")
  })
})
