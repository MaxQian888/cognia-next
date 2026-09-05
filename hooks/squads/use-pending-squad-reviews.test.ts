/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { ExecutionRunInterrupt } from "@/types/execution/run"
import {
  listPendingSquadReviews,
  projectPendingSquadReviews,
  squadRunIdFromExecutionRunId,
} from "./use-pending-squad-reviews"

function interrupt(over: Partial<ExecutionRunInterrupt>): ExecutionRunInterrupt {
  return {
    id: `i-${Math.random()}`,
    runId: "execution:team:run_a",
    type: "plan_approval",
    status: "pending",
    title: "plan",
    expiresAt: 10_000,
    createdAt: 1_000,
    reviewKind: "plan",
    ...over,
  }
}

describe("projectPendingSquadReviews", () => {
  it("keeps only pending Squad reviews whose run names a team, newest first", () => {
    const teamIdByRunId = new Map([
      ["run_a", "team-a"],
      ["run_b", "team-b"],
    ])
    const rows = projectPendingSquadReviews(
      [
        interrupt({ id: "old", createdAt: 1 }),
        interrupt({
          id: "new",
          createdAt: 5,
          runId: "execution:team:run_b",
          reviewKind: "deadlock",
        }),
        interrupt({ id: "settled", status: "approved" }),
        interrupt({ id: "tool", reviewKind: undefined, type: "tool_approval" }),
        interrupt({ id: "orphan", runId: "execution:team:run_zzz" }),
        interrupt({ id: "not-a-team", runId: "execution:bot:run_a" }),
      ],
      teamIdByRunId
    )
    expect(rows.map((row) => row.interruptId)).toEqual(["new", "old"])
    expect(rows[0]).toMatchObject({
      teamId: "team-b",
      runId: "run_b",
      executionRunId: "execution:team:run_b",
      kind: "deadlock",
      status: "open",
    })
  })

  it("parses the Squad run id out of the execution run id", () => {
    expect(squadRunIdFromExecutionRunId("execution:team:run_team_1")).toBe("run_team_1")
    expect(squadRunIdFromExecutionRunId("execution:bot:x")).toBeUndefined()
  })
})

describe("listPendingSquadReviews", () => {
  let disableDbRuntime: (() => void) | undefined
  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("joins pending interrupts to their Squad through the durable run record", async () => {
    await getDb().agentTeamRuns.add({
      id: "run_a",
      teamId: "team-a",
      objective: "o",
      status: "needs_input",
      priority: 0,
      decisionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await getDb().executionRunInterrupts.bulkAdd([
      interrupt({ id: "i1" }),
      interrupt({ id: "i2", status: "denied" }),
    ])
    const rows = await listPendingSquadReviews()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ interruptId: "i1", teamId: "team-a", kind: "plan" })
  })

  it("returns nothing when no review is pending", async () => {
    expect(await listPendingSquadReviews()).toEqual([])
  })
})
