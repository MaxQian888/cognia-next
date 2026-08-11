import {
  GOVERNANCE_CONTRACT_VERSION,
  isConflictSet,
  isDecisionCase,
  isEvidenceRef,
  isLineageEdge,
  isProvenanceEnvelope,
  validateDecisionCase,
  validateProvenanceEnvelope,
  type ConflictSetV1,
  type DecisionCaseV1,
  type EvidenceRefV1,
  type LineageEdgeV1,
  type ProvenanceEnvelopeV1,
} from "./governance"

const resource = (type: string, id: string) => ({ namespace: "cognia", type, id })

function evidence(): EvidenceRefV1 {
  return {
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: "evidence-1",
    kind: "message",
    sourceRef: resource("message", "message-1"),
    digest: { algorithm: "sha256", value: "a".repeat(64), canonicalization: "utf8-v1" },
    observedAt: 1_000,
    review: { status: "verified" },
    contamination: "clean",
    privacy: {
      classification: "private",
      retentionClass: "session",
      contentCaptured: false,
    },
  }
}

function decision(): DecisionCaseV1 {
  return {
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: "decision-1",
    mode: "control",
    kind: "tool-authorization",
    subjectRef: resource("tool-call", "request-1"),
    question: { code: "may-execute" },
    proposer: { kind: "agent", ref: resource("agent", "assistant") },
    decider: { kind: "human", ref: resource("user", "local") },
    basis: { evidenceRefs: ["evidence-1"], policyRefs: [], parentDecisionRefs: [] },
    resolution: {
      outcome: "allow",
      reasonCode: "human-approved",
      rationaleOrigin: "human",
    },
    lifecycle: { state: "resolved", decidedAt: 1_100, recordedAt: 1_101 },
    correlation: { sessionId: "session-1", requestId: "request-1" },
    privacy: {
      classification: "private",
      retentionClass: "audit-90d",
      contentCaptured: false,
      removedFields: [],
    },
  }
}

describe("governance contract", () => {
  it("accepts a content-free evidence reference", () => {
    expect(isEvidenceRef(evidence())).toBe(true)
  })

  it("accepts a resolved control decision with distinct proposer and decider", () => {
    expect(validateDecisionCase(decision())).toEqual([])
    expect(isDecisionCase(decision())).toBe(true)
  })

  it("rejects a resolved decision without a resolution or decision timestamp", () => {
    const value = decision()
    delete value.resolution
    delete value.lifecycle.decidedAt

    expect(validateDecisionCase(value)).toEqual(
      expect.arrayContaining([
        "resolution is required for a resolved decision",
        "lifecycle.decidedAt is required for a resolved decision",
      ])
    )
  })

  it("rejects credential-bearing resource references", () => {
    const value = decision()
    value.subjectRef.id = "https://user:secret@example.com/tool"

    expect(validateDecisionCase(value)).toContain("subjectRef.id: must be an id/ref, not a URL")
  })

  it("accepts an explicit contradiction lineage edge", () => {
    const edge: LineageEdgeV1 = {
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "edge-1",
      from: resource("assertion", "a"),
      to: resource("assertion", "b"),
      relation: "contradicts",
      assertion: "explicit",
      evidenceRefs: ["evidence-1"],
      recordedAt: 1_200,
    }

    expect(isLineageEdge(edge)).toBe(true)
  })

  it("accepts an open conflict with independently sourced members", () => {
    const conflict: ConflictSetV1 = {
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "conflict-1",
      subjectRef: resource("project", "p1"),
      predicate: { namespace: "preference", key: "package-manager" },
      scope: { projectId: "p1" },
      members: [
        {
          assertionRef: resource("memory", "m1"),
          valueDigest: "npm",
          evidenceRefs: ["e1"],
          observedAt: 1_000,
          authorityClass: "explicit-user",
        },
        {
          assertionRef: resource("memory", "m2"),
          valueDigest: "pnpm",
          evidenceRefs: ["e2"],
          observedAt: 1_001,
          authorityClass: "connector-derived",
        },
      ],
      detection: {
        kind: "mutually-exclusive",
        detectorRef: resource("detector", "semantic-v1"),
        policyRef: { namespace: "governance", id: "conflict-v1", digest: "b".repeat(64) },
      },
      risk: "high",
      recommendation: { kind: "supersede-right", reasonCode: "explicit-user-authority" },
      status: "open",
      createdAt: 1_100,
    }

    expect(isConflictSet(conflict)).toBe(true)
  })

  it("keeps provenance metadata primitive and reference-only", () => {
    const envelope: ProvenanceEnvelopeV1 = {
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      eventId: "event-1",
      eventType: "decision.resolved",
      source: "cognia://workflow/runtime",
      subjectRef: resource("decision", "decision-1"),
      occurredAt: 1_100,
      recordedAt: 1_101,
      correlation: { runId: "run-1" },
      actorRefs: [resource("user", "local")],
      decisionRefs: ["decision-1"],
      evidenceRefs: ["evidence-1"],
      inputRefs: [],
      outputRefs: [resource("artifact", "artifact-1")],
      policyRefs: [],
      privacy: {
        classification: "private",
        redactionVersion: "pii-v1",
        contentCaptured: false,
        removedFields: [],
        retentionClass: "audit-90d",
      },
      data: { outcome: "allow", attempt: 1, replay: false },
    }

    expect(validateProvenanceEnvelope(envelope)).toEqual([])
    expect(isProvenanceEnvelope(envelope)).toBe(true)

    const invalid = { ...envelope, data: { raw: { secret: "value" } } }
    expect(validateProvenanceEnvelope(invalid)).toContain("data values must be primitive or null")
  })
})
