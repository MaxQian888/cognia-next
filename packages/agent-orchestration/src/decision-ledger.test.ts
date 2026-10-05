import { createDecisionLedger, classifyDecisionConflict } from "./decision-ledger"
import { createMemoryTeamRunStore } from "./memory-store"
import type { AgentTeamDecision } from "./records"
import { contractRun } from "./store-contract"
import type { TeamRunStore } from "./store"

describe("AgentTeam decision ledger", () => {
  let store: TeamRunStore

  beforeEach(async () => {
    store = createMemoryTeamRunStore()
    await store.createRun(contractRun({ teamId: "team-1", objective: "Ship", priority: 1 }))
    await store.putEvidence({
      id: "evidence-1",
      runId: "run-1",
      childRunId: "child-1",
      taskId: "task-1",
      kind: "activity",
      title: "Observed migration behavior",
      createdAt: 2,
    })
  })

  it("keeps user constraints immutable and gives the lead acceptance authority", async () => {
    const ledger = createDecisionLedger({ store, runId: "run-1", leadId: "lead-1", now: () => 10 })
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
    expect((await store.getRun("run-1"))?.decisionVersion).toBe(1)
    expect(context).toContain("Do not break the public API")
    expect(context).toContain("Use an additive table")
  })

  it("rejects a proposal without changing the accepted decision version", async () => {
    const ledger = createDecisionLedger({ store, runId: "run-1", leadId: "lead-1", now: () => 20 })
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
    expect((await store.getRun("run-1"))?.decisionVersion).toBe(0)
    expect(await ledger.context()).not.toContain("Rewrite everything")
  })

  it("refuses proposal evidence from another run or listed twice", async () => {
    await store.putEvidence({
      id: "evidence-elsewhere",
      runId: "run-2",
      taskId: "task-1",
      kind: "activity",
      title: "Another run",
      createdAt: 3,
    })
    const ledger = createDecisionLedger({ store, runId: "run-1", leadId: "lead-1" })
    const base = { authorId: "child-1", title: "Shape", detail: "Additive" }
    await expect(ledger.propose({ ...base, evidenceIds: ["evidence-elsewhere"] })).rejects.toThrow(
      /same durable run/
    )
    await expect(
      ledger.propose({ ...base, evidenceIds: ["evidence-1", "evidence-1"] })
    ).rejects.toThrow(/same durable run/)
    await expect(ledger.propose({ ...base, evidenceIds: ["missing"] })).rejects.toThrow(
      /same durable run/
    )
    expect(await store.listDecisions("run-1")).toEqual([])
  })

  it("records proposals and acceptances in the run trajectory", async () => {
    const ledger = createDecisionLedger({ store, runId: "run-1", leadId: "lead-1", now: () => 30 })
    const proposal = await ledger.propose({
      authorId: "child-1",
      title: "Shape",
      detail: "Additive",
      evidenceIds: ["evidence-1"],
    })
    await ledger.accept(proposal.id, "lead-1")
    await expect(ledger.accept(proposal.id, "lead-1")).rejects.toThrow(/not pending/)
    expect(
      (await store.listTrajectory("run-1")).map((event) => [event.kind, event.correlationId])
    ).toEqual([
      ["decision_proposed", proposal.id],
      ["decision_accepted", proposal.id],
    ])
  })

  it("advances the decision version exactly once per acceptance under concurrency", async () => {
    const ledger = createDecisionLedger({ store, runId: "run-1", leadId: "lead-1" })
    const proposals = await Promise.all(
      ["a", "b", "c"].map((detail) =>
        ledger.propose({ authorId: "child-1", title: detail, detail, evidenceIds: ["evidence-1"] })
      )
    )
    const accepted = await Promise.all(
      proposals.map((proposal) => ledger.accept(proposal.id, "lead-1"))
    )
    expect(accepted.map((decision) => decision.version).sort()).toEqual([1, 2, 3])
    expect((await store.getRun("run-1"))?.decisionVersion).toBe(3)
  })
})

describe("decision conflict classification", () => {
  const proposal = (overrides: Partial<AgentTeamDecision> = {}) => ({
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
