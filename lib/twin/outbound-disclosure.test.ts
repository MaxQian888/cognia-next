import {
  DIGITAL_TWIN_DISCLOSURE,
  discloseTwinOutboundSegments,
  enforceTwinDisclosureFromProvenance,
  twinShareProvenance,
} from "./outbound-disclosure"

describe("digital-twin outbound disclosure", () => {
  it("adds one visible marker and structured provenance", () => {
    const result = discloseTwinOutboundSegments([{ type: "markdown", md: "Answer" }], "twin-1")
    expect(result.segments).toEqual([
      { type: "markdown", md: "Answer\n\n[AI-generated · Digital Twin]" },
    ])
    expect(result.provenance).toEqual(twinShareProvenance("twin-1"))
  })

  it("does not duplicate an existing marker", () => {
    const result = discloseTwinOutboundSegments(
      [{ type: "text", text: "Answer\n\n[AI-generated · Digital Twin]" }],
      "twin-1"
    )
    expect(result.segments).toHaveLength(1)
  })

  it("re-applies a stripped visible marker from structured provenance", () => {
    expect(
      enforceTwinDisclosureFromProvenance(
        [{ type: "text", text: "rewritten" }],
        [{ source: "digital-twin", sourceId: "twin-1", disclosure: "ai-generated" }]
      )
    ).toEqual([{ type: "text", text: `rewritten\n\n${DIGITAL_TWIN_DISCLOSURE}` }])
  })
})
