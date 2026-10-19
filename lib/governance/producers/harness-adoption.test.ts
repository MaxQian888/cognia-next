/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDecisionContext } from "@/lib/db/governance-ledger"
import {
  harnessAdoptionDecisionId,
  harnessRestoreDecisionId,
  recordHarnessAdoptionGovernance,
  recordHarnessRestoreGovernance,
  recordHarnessRollbackGovernance,
} from "./harness-adoption"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

const input = {
  runId: "run-1",
  characterId: "agent-1",
  targetCharacterId: "agent-1-evolved",
  scope: "workspace",
  baseContentHash: "base-hash",
  chosenContentHash: "chosen-hash",
  chosenSnapshotId: "snap-2",
  risk: "medium",
  reason: "agg1 beat every base rollout on deterministic evidence.",
  applyId: "apply-1",
  decidedAt: 100,
}

it("records a person's approval without any harness text", async () => {
  const id = await recordHarnessAdoptionGovernance({ ...input, approvedBy: "person" })
  expect(id).toBe(harnessAdoptionDecisionId("run-1"))
  const context = await getDecisionContext(id)
  expect(context?.decision).toMatchObject({
    kind: "harness-adoption",
    subjectRef: { type: "agent", id: "agent-1-evolved" },
    decider: { kind: "human" },
    resolution: { outcome: "adopted", rationaleOrigin: "human" },
    lifecycle: { state: "executed" },
  })
  expect(context?.events.map((e) => e.type)).toEqual(["executed"])
})

it("records an automatic low-risk adoption and its rollback", async () => {
  const id = await recordHarnessAdoptionGovernance({
    ...input,
    approvedBy: "auto-low-risk",
    applyId: undefined,
  })
  const context = await getDecisionContext(id)
  expect(context?.decision.decider).toMatchObject({ kind: "system" })
  expect(context?.decision.resolution?.rationaleOrigin).toBe("rule")
  await recordHarnessRollbackGovernance({
    runId: "run-1",
    targetCharacterId: "agent-1-evolved",
    at: 200,
  })
  const after = await getDecisionContext(id)
  expect(after?.events.map((e) => e.type)).toEqual(["executed", "revoked"])
})

it("records a person restoring an earlier version", async () => {
  const id = await recordHarnessRestoreGovernance({
    restoredSnapshotId: "snap-restored",
    sourceSnapshotId: "snap-old",
    characterId: "agent-1",
    currentContentHash: "now-hash",
    restoredContentHash: "old-hash",
    risk: "medium",
    applyId: "apply-9",
    decidedAt: 300,
  })
  expect(id).toBe(harnessRestoreDecisionId("snap-restored"))
  const context = await getDecisionContext(id)
  expect(context?.decision).toMatchObject({
    kind: "harness-adoption",
    question: { code: "restore-harness-version" },
    subjectRef: { type: "agent", id: "agent-1" },
    decider: { kind: "human" },
    resolution: { outcome: "adopted", reasonCode: "restored" },
  })
  expect(JSON.stringify(context)).not.toMatch(/systemPrompt"\s*:\s*"/)
  expect(context?.events.map((e) => e.type)).toEqual(["executed"])
})
