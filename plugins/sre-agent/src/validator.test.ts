import { LOG_EVIDENCE, METRIC_EVIDENCE } from "./fixtures"
import { validateTimelineDraft } from "./validator"

describe("validateTimelineDraft", () => {
  it("rejects an empty timeline and malformed rows", () => {
    const empty = validateTimelineDraft({ rows: [] }, LOG_EVIDENCE)
    const malformed = validateTimelineDraft({ rows: [null as never] }, LOG_EVIDENCE)

    expect(empty.issues.map((item) => item.code)).toContain("timeline.empty")
    expect(malformed.issues.map((item) => item.code)).toContain("row.invalid")
  })

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

  it("rejects invalid confidence and unsupported finding evidence", () => {
    const result = validateTimelineDraft(
      {
        rows: [
          {
            time: "12:02:54",
            component: "gateway",
            event: "fallback occurred",
            signals: [],
            evidenceIds: ["log_004"],
            sources: ["logs", "file"],
            confidence: 2,
            flags: ["fallback"],
          },
        ],
        findings: [{ text: "token was exposed", evidenceIds: ["missing"] }],
      },
      LOG_EVIDENCE
    )

    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "row.confidence_invalid",
        "finding.evidence_unknown",
        "finding.sensitive_text",
      ])
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

  it.each(["tenant t-001", "user u-123", "client IP 10.20.30.40"])(
    "rejects unredacted subject data: %s",
    (event) => {
      const result = validateTimelineDraft(
        {
          rows: [
            {
              time: "12:02:09",
              component: "gateway",
              event,
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

      expect(result.issues.map((issue) => issue.code)).toContain("row.sensitive_text")
    }
  )

  it("rejects fabricated provider, status, model, latency, component, and event claims", () => {
    const result = validateTimelineDraft(
      {
        rows: [
          {
            time: "12:02:54",
            component: "database",
            event: "database corrupted provider qwen-vllm-c status=500 model=qwen4-99b 999ms",
            signals: [],
            evidenceIds: ["log_004"],
            sources: ["logs"],
            confidence: 0.9,
            flags: ["error"],
          },
        ],
      },
      LOG_EVIDENCE
    )

    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "row.component_unsupported",
        "row.claim_unsupported",
        "row.event_unsupported",
      ])
    )
  })

  it("rejects request events inferred from metrics alone", () => {
    const result = validateTimelineDraft(
      {
        rows: [
          {
            time: "12:02:54",
            component: "gateway",
            event: "fallback occurred",
            signals: ["fallback"],
            evidenceIds: ["metric_001"],
            sources: ["metrics"],
            confidence: 0.7,
            flags: ["fallback"],
          },
        ],
      },
      METRIC_EVIDENCE
    )

    expect(result.issues.map((issue) => issue.code)).toContain("row.metrics_only_event")
  })
})
