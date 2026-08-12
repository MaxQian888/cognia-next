/** @jest-environment jsdom */

import { GOVERNANCE_CONTRACT_VERSION } from "@cognia/agent-config-types/governance"
import { createDbTestFixture } from "./test-fixture"
import {
  appendDecisionEvent,
  getDecisionContext,
  recordConflictSet,
  recordDecision,
  recordEvidenceRef,
  recordLineageEdge,
  recordProvenanceEnvelope,
  resolveConflictSet,
  listDecisionContextsByCorrelation,
  listRecentGovernanceAuditGaps,
  listRecentDecisions,
  reportGovernanceProjectionFailure,
} from "./governance-ledger"

const ref = (type: string, id: string) => ({ namespace: "cognia", type, id })
const privacy = {
  classification: "private",
  retentionClass: "audit-90d",
  contentCaptured: false,
  removedFields: [] as string[],
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("governance ledger", () => {
  it("records a decision idempotently and advances its projection from events", async () => {
    const decision = {
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "decision-1",
      mode: "control" as const,
      kind: "workflow-branch" as const,
      subjectRef: ref("workflow-step", "run-1:step-1"),
      question: { code: "select-edge" },
      basis: { evidenceRefs: [], policyRefs: [], parentDecisionRefs: [] },
      lifecycle: { state: "proposed" as const, proposedAt: 100, recordedAt: 100 },
      correlation: { runId: "run-1", workflowId: "workflow-1", stepId: "step-1" },
      privacy,
    }

    await recordDecision(decision)
    await recordDecision(decision)
    await appendDecisionEvent({
      id: "event-resolve-1",
      decisionId: decision.id,
      type: "resolved",
      at: 110,
      outcome: "true",
      reasonCode: "condition-result",
    })
    await appendDecisionEvent({
      id: "event-execute-1",
      decisionId: decision.id,
      type: "executed",
      at: 120,
    })

    const context = await getDecisionContext(decision.id)
    expect(context?.decision.lifecycle).toMatchObject({
      state: "executed",
      decidedAt: 110,
      executedAt: 120,
    })
    expect(context?.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "resolved"],
      [2, "executed"],
    ])
  })

  it("deduplicates a replayed event by its producer id", async () => {
    await recordDecision({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "decision-replay",
      mode: "control",
      kind: "execution-route",
      subjectRef: ref("execution", "run-2"),
      question: { code: "select-runtime" },
      basis: { evidenceRefs: [], policyRefs: [], parentDecisionRefs: [] },
      lifecycle: { state: "proposed", recordedAt: 100 },
      correlation: { runId: "run-2" },
      privacy,
    })
    const event = {
      id: "same-event",
      decisionId: "decision-replay",
      type: "resolved" as const,
      at: 110,
      outcome: "ai-sdk",
      reasonCode: "explicit-policy",
    }

    await appendDecisionEvent(event)
    await appendDecisionEvent(event)

    expect((await getDecisionContext("decision-replay"))?.events).toHaveLength(1)
  })

  it("rejects stable-id collisions instead of silently merging different records", async () => {
    const first = {
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "collision",
      mode: "control" as const,
      kind: "execution-route" as const,
      subjectRef: ref("execution", "one"),
      question: { code: "route" },
      basis: { evidenceRefs: [], policyRefs: [], parentDecisionRefs: [] },
      lifecycle: { state: "proposed" as const, recordedAt: 100 },
      correlation: {},
      privacy,
    }
    await recordDecision(first)

    await expect(recordDecision({ ...first, subjectRef: ref("execution", "two") })).rejects.toThrow(
      "identity collision"
    )

    const evidence = {
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "evidence-collision",
      kind: "manual" as const,
      sourceRef: ref("manual", "one"),
      digest: { algorithm: "sha256" as const, value: "a".repeat(64), canonicalization: "v1" },
      observedAt: 100,
      review: { status: "unreviewed" as const },
      contamination: "unknown" as const,
      privacy,
    }
    await recordEvidenceRef(evidence)
    await expect(
      recordEvidenceRef({ ...evidence, digest: { ...evidence.digest, value: "b".repeat(64) } })
    ).rejects.toThrow("identity collision")
  })

  it("allocates event sequences from sequence values rather than event id order", async () => {
    await recordDecision({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "decision-sequence",
      mode: "control",
      kind: "execution-route",
      subjectRef: ref("execution", "run-sequence"),
      question: { code: "select-runtime" },
      basis: { evidenceRefs: [], policyRefs: [], parentDecisionRefs: [] },
      lifecycle: { state: "proposed", recordedAt: 100 },
      correlation: { runId: "run-sequence" },
      privacy,
    })
    await appendDecisionEvent({
      id: "z-first",
      decisionId: "decision-sequence",
      type: "resolved",
      at: 110,
    })
    await appendDecisionEvent({
      id: "a-second",
      decisionId: "decision-sequence",
      type: "executed",
      at: 120,
    })

    expect(
      (await getDecisionContext("decision-sequence"))?.events.map((event) => event.sequence)
    ).toEqual([1, 2])
  })

  it("joins evidence and lineage without copying source content", async () => {
    await recordEvidenceRef({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "evidence-1",
      kind: "capture",
      sourceRef: ref("capture", "capture-1"),
      digest: { algorithm: "sha256", value: "a".repeat(64), canonicalization: "utf8-v1" },
      observedAt: 100,
      review: { status: "unreviewed" },
      contamination: "external-context",
      privacy,
    })
    await recordDecision({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "decision-evidence",
      mode: "observed",
      kind: "twin-observation",
      subjectRef: ref("twin-decision", "twin-1:d1"),
      question: { code: "observed-choice" },
      basis: { evidenceRefs: ["evidence-1"], policyRefs: [], parentDecisionRefs: [] },
      lifecycle: { state: "observed", recordedAt: 101 },
      correlation: {},
      privacy,
    })
    await recordLineageEdge({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "edge-1",
      from: ref("evidence", "evidence-1"),
      to: ref("decision", "decision-evidence"),
      relation: "supported-by",
      assertion: "explicit",
      evidenceRefs: ["evidence-1"],
      recordedAt: 101,
    })

    const context = await getDecisionContext("decision-evidence")
    expect(context?.evidence.map((item) => item.id)).toEqual(["evidence-1"])
    expect(context?.lineage.map((edge) => edge.id)).toEqual(["edge-1"])
    expect(JSON.stringify(context)).not.toContain("raw content")
  })

  it("resolves a conflict through an existing decision", async () => {
    await recordDecision({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "resolution-1",
      mode: "control",
      kind: "fact-resolution",
      subjectRef: ref("conflict", "conflict-1"),
      question: { code: "resolve-conflict" },
      basis: { evidenceRefs: [], policyRefs: [], parentDecisionRefs: [] },
      resolution: {
        outcome: "keep-left",
        reasonCode: "human-review",
        rationaleOrigin: "human",
      },
      lifecycle: { state: "resolved", decidedAt: 200, recordedAt: 200 },
      correlation: {},
      privacy,
    })
    await recordConflictSet({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "conflict-1",
      subjectRef: ref("project", "p1"),
      predicate: { namespace: "preference", key: "package-manager" },
      scope: { projectId: "p1" },
      members: [
        {
          assertionRef: ref("memory", "m1"),
          valueDigest: "npm",
          evidenceRefs: [],
          observedAt: 1,
          authorityClass: "local-derived",
        },
        {
          assertionRef: ref("memory", "m2"),
          valueDigest: "pnpm",
          evidenceRefs: [],
          observedAt: 2,
          authorityClass: "local-derived",
        },
      ],
      detection: {
        kind: "mutually-exclusive",
        detectorRef: ref("detector", "v1"),
        policyRef: { namespace: "governance", id: "conflict-v1", digest: "b".repeat(64) },
      },
      risk: "high",
      status: "open",
      createdAt: 100,
    })

    await resolveConflictSet("conflict-1", "resolution-1", 200)
    const context = await getDecisionContext("resolution-1")
    expect(context?.conflicts).toEqual([
      expect.objectContaining({
        id: "conflict-1",
        status: "resolved",
        resolutionDecisionRef: "resolution-1",
        resolvedAt: 200,
      }),
    ])
  })

  it("stores a compact provenance envelope linked to the decision", async () => {
    await recordDecision({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: "decision-envelope",
      mode: "control",
      kind: "connector-action",
      subjectRef: ref("connector-action", "action-1"),
      question: { code: "send" },
      basis: { evidenceRefs: [], policyRefs: [], parentDecisionRefs: [] },
      lifecycle: { state: "proposed", recordedAt: 100 },
      correlation: { runId: "run-3" },
      privacy,
    })
    await recordProvenanceEnvelope({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      eventId: "provenance-1",
      eventType: "connector.action.proposed",
      source: "cognia://connector/runtime",
      subjectRef: ref("connector-action", "action-1"),
      occurredAt: 100,
      recordedAt: 101,
      correlation: { runId: "run-3" },
      actorRefs: [],
      decisionRefs: ["decision-envelope"],
      evidenceRefs: [],
      inputRefs: [],
      outputRefs: [],
      policyRefs: [],
      privacy: { ...privacy, redactionVersion: "pii-v1" },
      data: { route: "ai-run" },
    })

    expect((await getDecisionContext("decision-envelope"))?.provenance).toEqual([
      expect.objectContaining({ eventId: "provenance-1" }),
    ])
  })

  it("lists recent decisions newest first with a validated bound", async () => {
    const makeDecision = (id: string, recordedAt: number) => ({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id,
      mode: "control" as const,
      kind: "execution-route" as const,
      subjectRef: ref("execution", id),
      question: { code: "route" },
      basis: { evidenceRefs: [], policyRefs: [], parentDecisionRefs: [] },
      lifecycle: { state: "resolved" as const, decidedAt: recordedAt, recordedAt },
      correlation: {},
      privacy,
      resolution: { outcome: id, reasonCode: "test", rationaleOrigin: "system" as const },
    })
    await recordDecision(makeDecision("older", 1))
    await recordDecision(makeDecision("newer", 2))

    await expect(listRecentDecisions(1)).resolves.toEqual([
      expect.objectContaining({ id: "newer" }),
    ])
    await expect(listRecentDecisions(0)).rejects.toThrow("positive integer")
    await expect(listDecisionContextsByCorrelation({ runId: "missing" })).resolves.toEqual([])
  })

  it("records projection failures as content-free audit gaps", async () => {
    await reportGovernanceProjectionFailure(
      {
        producer: "capture",
        operation: "persist",
        subjectRef: ref("capture", "capture-1"),
        occurredAt: 123,
      },
      new Error("failed for alice@example.com")
    )

    const gaps = await listRecentGovernanceAuditGaps()
    expect(gaps).toEqual([
      expect.objectContaining({
        eventType: "governance.projection.failed",
        subjectKey: "cognia:capture:capture-1",
        data: { producer: "capture", operation: "persist", errorType: "Error" },
      }),
    ])
    expect(JSON.stringify(gaps)).not.toContain("alice@example.com")
  })

  it("keeps workflow correlation on projection audit gaps", async () => {
    await reportGovernanceProjectionFailure(
      {
        producer: "workflow-branch",
        operation: "record",
        subjectRef: {
          namespace: "cognia",
          type: "workflow-step",
          id: "run_abc:n_branch",
          scope: { projectId: "project-default" },
        },
        occurredAt: 456,
        correlation: {
          traceId: "10a7970a584a4c157d38435c050eb98b",
          runId: "run_abc",
          workflowId: "wf_x",
          stepId: "n_branch",
        },
      },
      new Error("ledger unavailable")
    )

    await expect(listRecentGovernanceAuditGaps()).resolves.toEqual([
      expect.objectContaining({
        subjectKey: "cognia:workflow-step:run_abc:n_branch",
        runId: "run_abc",
        projectId: "project-default",
      }),
    ])
  })

  it("rejects PII at every mutable ledger boundary", async () => {
    const leaking = "alice@example.com"
    await expect(recordDecision({ resolution: { rationale: leaking } } as never)).rejects.toThrow(
      "PII gate"
    )
    await expect(appendDecisionEvent({ reasonCode: leaking } as never)).rejects.toThrow("PII gate")
    await expect(recordEvidenceRef({ excerpt: leaking } as never)).rejects.toThrow("PII gate")
    await expect(recordLineageEdge({ id: leaking } as never)).rejects.toThrow("PII gate")
    await expect(recordConflictSet({ predicate: { key: leaking } } as never)).rejects.toThrow(
      "PII gate"
    )
    await expect(recordProvenanceEnvelope({ data: { note: leaking } } as never)).rejects.toThrow(
      "PII gate"
    )
    await expect(resolveConflictSet(leaking, "decision", 1)).rejects.toThrow("PII gate")
  })
})
