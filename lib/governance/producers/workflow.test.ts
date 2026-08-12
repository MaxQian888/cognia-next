/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDecisionContext } from "@/lib/db/governance-ledger"
import { recordWorkflowBranchGovernance } from "./workflow"
import { sha256Hex } from "@/lib/data/crypto"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

it("records the chosen and unchosen workflow routes without step output content", async () => {
  const policySnapshot = {
    nodeType: "flow.branch",
    nodeTypeVersion: 2,
    params: { conditions: { combinator: "and", conditions: [{ operator: "is-true" }] } },
  }
  const evaluationSnapshot = { decision: "true", output: { decision: "true" } }
  await recordWorkflowBranchGovernance({
    workflowId: "workflow-1",
    workflowVersionId: "version-2",
    runId: "run-1",
    stepId: "condition-1",
    traceId: "trace-1",
    attempt: 1,
    chosenRouteKeys: ["true"],
    availableRouteKeys: ["true", "false"],
    policySnapshot,
    evaluationSnapshot,
    reasonCode: "condition-evaluated",
    rationale: "flow.branch@2 selected 1 of 2 routes after evaluating its frozen policy.",
    decidedAt: 1_000,
  })

  const context = await getDecisionContext("workflow-branch:run-1:condition-1:1")
  expect(context).toMatchObject({
    decision: {
      kind: "workflow-branch",
      resolution: {
        outcome: "true",
        reasonCode: "condition-evaluated",
        rationale: "flow.branch@2 selected 1 of 2 routes after evaluating its frozen policy.",
      },
      correlation: { runId: "run-1", stepId: "condition-1", traceId: "trace-1" },
    },
    events: [{ type: "resolved" }, { type: "executed" }],
    provenance: [
      expect.objectContaining({
        data: {
          chosenCount: 1,
          availableCount: 2,
          reasonCode: "condition-evaluated",
        },
      }),
    ],
  })
  expect(context?.decision.basis.policyRefs[0]?.digest).toBe(
    await sha256Hex(JSON.stringify(policySnapshot))
  )
  expect(context?.evidence[0]?.digest.value).toBe(
    await sha256Hex(JSON.stringify(evaluationSnapshot))
  )
  expect(context?.evidence[0]?.digest.value).not.toBe(context?.decision.basis.policyRefs[0]?.digest)
  expect(JSON.stringify(context)).not.toContain("step output")
  expect(JSON.stringify(context)).not.toContain("is-true")
})
