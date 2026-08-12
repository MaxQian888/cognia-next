/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDecisionContext } from "@/lib/db/governance-ledger"
import { recordMemoryConflictGovernance } from "./memory"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

it("records the Memory conflict, evidence, resolution and supersession lineage", async () => {
  const decisionId = await recordMemoryConflictGovernance({
    commandId: "command-1",
    keep: {
      id: "m1",
      text: "Uses pnpm",
      version: 2,
      createdAt: 100,
      updatedAt: 200,
      projectId: "p1",
      provenance: "explicit",
    },
    drop: {
      id: "m2",
      text: "Uses npm",
      version: 1,
      createdAt: 90,
      updatedAt: 190,
      projectId: "p1",
      provenance: "inbound",
    },
    mode: "keep",
    actorId: "local-user",
    rationale: "The user confirmed the newer package manager",
    resolvedAt: 300,
  })

  expect(decisionId).toBe("memory-resolution:command-1")
  const context = await getDecisionContext(decisionId)
  expect(context).toMatchObject({
    decision: {
      kind: "memory-resolution",
      resolution: {
        outcome: "keep",
        reasonCode: "human-conflict-resolution",
        rationale: "The user confirmed the newer package manager",
      },
    },
    conflicts: [
      expect.objectContaining({
        id: "memory-conflict:m1:m2",
        status: "resolved",
        resolutionDecisionRef: decisionId,
      }),
    ],
  })
  expect(context?.evidence).toHaveLength(2)
  expect(context?.lineage.map((edge) => edge.relation)).toEqual(
    expect.arrayContaining(["supported-by", "supersedes"])
  )
  expect(JSON.stringify(context)).not.toContain("Uses pnpm")
})

it("redacts a human rationale before it reaches the governance ledger", async () => {
  const decisionId = await recordMemoryConflictGovernance({
    commandId: "command-pii",
    keep: {
      id: "m3",
      text: "first",
      version: 1,
      createdAt: 100,
      updatedAt: 200,
      provenance: "explicit",
    },
    drop: {
      id: "m4",
      text: "second",
      version: 1,
      createdAt: 110,
      updatedAt: 210,
      provenance: "inbound",
    },
    mode: "keep",
    actorId: "local-user",
    rationale: "Confirmed by alice@example.com",
    resolvedAt: 300,
  })

  const context = await getDecisionContext(decisionId)
  expect(context?.decision.resolution?.rationale).toBeDefined()
  expect(JSON.stringify(context)).not.toContain("alice@example.com")
})

it("links merge evidence and the decision to the new memory version", async () => {
  const decisionId = await recordMemoryConflictGovernance({
    commandId: "command-merge",
    keep: {
      id: "m5",
      text: "Uses npm",
      version: 3,
      createdAt: 100,
      updatedAt: 200,
      provenance: "explicit",
    },
    drop: {
      id: "m6",
      text: "Uses pnpm",
      version: 1,
      createdAt: 110,
      updatedAt: 210,
      provenance: "inbound",
    },
    result: {
      id: "m5",
      text: "Uses pnpm for this workspace",
      version: 4,
      createdAt: 100,
      updatedAt: 300,
      provenance: "explicit",
    },
    resolutionEvidence: {
      id: "manual-evidence-1",
      sourceId: "conflict-merge:m5:m6",
      createdAt: 300,
    },
    mode: "merge",
    actorId: "local-user",
    resolvedAt: 300,
  })

  const context = await getDecisionContext(decisionId)
  expect(context?.decision.basis.evidenceRefs).toContain("manual-evidence-1")
  expect(context?.lineage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        fromKey: `cognia:evidence:manual-evidence-1`,
        toKey: `cognia:decision:${decisionId}`,
        relation: "supported-by",
      }),
      expect.objectContaining({
        fromKey: `cognia:decision:${decisionId}`,
        toKey: "cognia:memory:m5@4",
        relation: "resulted-in",
      }),
    ])
  )
  expect(context?.provenance[0]?.outputRefs).toContainEqual(
    expect.objectContaining({ namespace: "cognia", type: "memory", id: "m5", version: "4" })
  )
})
