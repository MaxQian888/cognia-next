import type { RetrievalHit, RetrievalTraceV1 } from "./retrieval-kernel"
import { attachGroundingToTrace, groundAnswer } from "./grounding"

function hit(id: string, content: string): RetrievalHit {
  return {
    id,
    sourceId: "source",
    domain: "kb",
    content,
    tokenCount: 10,
    trust: "trusted",
    citation: { sourceRevision: "r1", startOffset: 0, endOffset: content.length },
    score: 1,
  }
}

describe("groundAnswer", () => {
  it("maps each exact answer claim to supporting chunk ids", () => {
    const result = groundAnswer(
      "The project uses pnpm. It targets Node 22.",
      [
        hit("chunk-1", "The project uses pnpm for package management."),
        hit("chunk-2", "Node 22 is required."),
      ],
      { path: "interactive_chat", claimThreshold: 0.5 }
    )

    expect(result.claims).toEqual([
      expect.objectContaining({ id: "claim-1", startOffset: 0, endOffset: 22 }),
      expect.objectContaining({ id: "claim-2", startOffset: 23 }),
    ])
    expect(result.support.map((item) => item.hitIds[0])).toEqual(["chunk-1", "chunk-2"])
    expect(result.action).toBe("allow")
  })

  it("annotates interactive answers but blocks or retries automatic paths", () => {
    const answer = "The project uses pnpm. Revenue doubled yesterday."
    const evidence = [hit("chunk-1", "The project uses pnpm.")]
    expect(
      groundAnswer(answer, evidence, { path: "interactive_chat", claimThreshold: 0.7 })
    ).toMatchObject({ blocked: false, action: "annotate", unsupportedClaimIds: ["claim-2"] })
    expect(
      groundAnswer(answer, evidence, {
        path: "automation",
        claimThreshold: 0.7,
        answerThreshold: 0.75,
      })
    ).toMatchObject({ blocked: true, action: "retry" })
    expect(
      groundAnswer(answer, evidence, {
        path: "external_send",
        claimThreshold: 0.7,
        answerThreshold: 0.75,
      })
    ).toMatchObject({ blocked: true, action: "block" })
  })

  it("adds only counts and state to the content-free trace", () => {
    const grounding = groundAnswer("Unsupported statement.", [], { path: "high_risk" })
    const trace = { traceId: "trace" } as RetrievalTraceV1
    expect(attachGroundingToTrace(trace, grounding).grounding).toEqual({
      supportedClaims: 0,
      unsupportedClaims: 1,
      blocked: true,
    })
  })
})
