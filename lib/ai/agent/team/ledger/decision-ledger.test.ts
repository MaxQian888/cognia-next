import "fake-indexeddb/auto"

import { createAgentTeamRun } from "@/lib/db/agent-team-runtime"
import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { classifyDecisionConflict, createDecisionLedger } from "./decision-ledger"

describe("AgentTeam decision ledger", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    await createAgentTeamRun({
      id: "run-1",
      teamId: "team-1",
      objective: "Ship",
      status: "running",
      priority: 1,
      decisionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await getDb().agentTeamEvidence.put({
      id: "evidence-1",
      runId: "run-1",
      childRunId: "child-1",
      taskId: "task-1",
      kind: "activity",
      title: "Observed migration behavior",
      createdAt: 2,
    })
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("keeps user constraints immutable and gives the lead acceptance authority", async () => {
    const ledger = createDecisionLedger({ runId: "run-1", leadId: "lead-1", now: () => 10 })
    const constraint = await ledger.addUserConstraint({
      title: "Compatibility",
      detail: "Do not break the public API",
    })
    const proposal = await ledger.propose({
      authorId: "child-1",
      title: "Migration shape",
      detail: "Use an additive table",
      evidenceIds: ["evidence-1"],
      impacts: ["public_api"],
    })

    await expect(ledger.accept(proposal.id, "child-1")).rejects.toThrow(/lead may accept/)
    const accepted = await ledger.accept(proposal.id, "lead-1")
    const context = await ledger.context()

    expect(constraint).toMatchObject({ status: "constraint", immutable: true, version: 0 })
    expect(accepted).toMatchObject({ status: "accepted", immutable: true, version: 1 })
    expect(proposal.conflict).toMatchObject({
      resolution: "escalate",
      reason: "high_risk_semantic_conflict",
      withDecisionIds: [constraint.id],
    })
    expect((await getDb().agentTeamRuns.get("run-1"))?.decisionVersion).toBe(1)
    expect(context).toContain("Do not break the public API")
    expect(context).toContain("Use an additive table")
  })

  it("rejects a proposal without changing the accepted decision version", async () => {
    const ledger = createDecisionLedger({ runId: "run-1", leadId: "lead-1", now: () => 20 })
    await expect(
      ledger.propose({
        authorId: "child-1",
        title: "Unsupported",
        detail: "No evidence",
        evidenceIds: [],
      })
    ).rejects.toThrow(/require durable evidence/)
    const proposal = await ledger.propose({
      authorId: "child-1",
      title: "Risky",
      detail: "Rewrite everything",
      evidenceIds: ["evidence-1"],
    })

    const rejected = await ledger.reject(proposal.id, "lead-1")
    expect(rejected.status).toBe("rejected")
    expect((await getDb().agentTeamRuns.get("run-1"))?.decisionVersion).toBe(0)
    expect(await ledger.context()).not.toContain("Rewrite everything")
  })
})

describe("decision conflict classification", () => {
  const proposal = (
    overrides: Partial<import("@/types/agent/agent-team-runtime").AgentTeamDecision> = {}
  ) => ({
    id: "decision",
    runId: "run",
    version: 1,
    status: "proposed" as const,
    title: "Change",
    detail: "one",
    authorId: "child",
    evidenceIds: [],
    immutable: false,
    createdAt: 1,
    ...overrides,
  })

  it("auto-resolves identical or disjoint changes and escalates high-risk overlap", () => {
    expect(classifyDecisionConflict(proposal(), proposal({ id: "two" })).resolution).toBe(
      "mechanical"
    )
    expect(
      classifyDecisionConflict(
        proposal({ compatibilityScopes: ["lib/a"] }),
        proposal({ id: "two", detail: "two", compatibilityScopes: ["lib/b"] })
      ).resolution
    ).toBe("compatible")
    expect(
      classifyDecisionConflict(
        proposal({ impacts: ["migration"] }),
        proposal({ id: "two", detail: "two" })
      ).resolution
    ).toBe("escalate")
  })
})
