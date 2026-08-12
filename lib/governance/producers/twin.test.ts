/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDecisionContext } from "@/lib/db/governance-ledger"
import { recordTwinDecisionsGovernance } from "./twin"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

it("records observed Twin decisions and opens a conflict before choices are merged", async () => {
  const ids = await recordTwinDecisionsGovernance({
    twinId: "twin-1",
    decisions: [
      {
        id: "d1",
        context: "Choose the package manager",
        choice: "npm",
        rationale: "Existing tooling",
        sourceChunkIds: ["chunk-1"],
      },
      {
        id: "d2",
        context: "Choose the package manager",
        choice: "pnpm",
        rationale: "Workspace support",
        sourceChunkIds: ["chunk-2"],
      },
    ],
    recordedAt: 1_000,
    distillJobId: "job-1",
  })

  expect(ids).toHaveLength(2)
  const context = await getDecisionContext(ids[0])
  expect(context?.decision).toMatchObject({
    mode: "observed",
    kind: "twin-observation",
    lifecycle: { state: "disputed" },
  })
  expect(context?.conflicts).toEqual([
    expect.objectContaining({
      status: "open",
      predicate: expect.objectContaining({ key: "choice" }),
    }),
  ])
  expect(context?.evidence.map((evidence) => evidence.sourceRef.id)).toEqual(["chunk-1"])
  expect(JSON.stringify(context)).not.toContain("Existing tooling")
  expect(JSON.stringify(context)).not.toContain("Workspace support")
})
