/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { ChatSession } from "@cognia/agent-config-types"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createExecutionRun,
  getExecutionRun,
  listExecutionRunEvents,
} from "@/lib/db/execution-runs"

import {
  acceptDelegation,
  adoptIntoDelegation,
  delegationExecutionRunId,
  hasActiveDelegationChild,
  listDelegationChildren,
  reviseDelegationPlan,
  settleDelegation,
} from "./delegation"

jest.mock("@/lib/db/connector-conversation-state", () => ({
  getConnectorConversationState: jest.fn(async () => ({
    deliveryTarget: { kind: "channel", channelId: "c-1" },
  })),
}))

jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: jest.fn(async () => undefined),
}))

function imSession(): ChatSession {
  return {
    id: "session-1",
    platformBinding: {
      adapterId: "adapter-1",
      conversationKey: "adapter-1:conv-1",
    },
  } as unknown as ChatSession
}

describe("delegation runs", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("opens the card in the same tick it accepts, without waiting for a plan", async () => {
    // `createExecutionRun` emits no event, and the presentation runner gates on
    // `revision > lastProjectedRevision` — so a run created and left to plan
    // quietly is invisible for exactly as long as the person is wondering
    // whether their request was heard.
    const { runId, created } = await acceptDelegation({
      delegationId: "d-1",
      title: "Draft the migration plan",
      session: imSession(),
    })

    expect(created).toBe(true)
    expect(runId).toBe(delegationExecutionRunId("d-1"))
    const run = await getExecutionRun(runId)
    expect(run?.kind).toBe("delegation")
    expect(run?.currentRevision).toBeGreaterThan(0)
    expect(run?.latestSnapshot?.status).toBe("running")

    const bindings = await getDb().executionRunBindings.where("runId").equals(runId).toArray()
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.conversationKey).toBe("adapter-1:conv-1")
  })

  it("carries a milestone skeleton onto the first projection when one exists", async () => {
    const { runId } = await acceptDelegation({
      delegationId: "d-2",
      title: "Ship the release",
      milestones: [
        { id: "m1", title: "Cut the branch" },
        { id: "m2", title: "Run the gates" },
      ],
    })

    const snapshot = (await getExecutionRun(runId))?.latestSnapshot
    expect(snapshot?.pendingSteps.map((step) => step.title)).toEqual([
      "Cut the branch",
      "Run the gates",
    ])
    // `trustworthy` is what lets a card print "0/2" instead of a bare count.
    expect(snapshot?.progress).toMatchObject({ completed: 0, total: 2, trustworthy: true })
  })

  it("treats a repeated accept as the same commitment, not a second card", async () => {
    const first = await acceptDelegation({ delegationId: "d-3", title: "Once" })
    const second = await acceptDelegation({ delegationId: "d-3", title: "Once" })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.runId).toBe(first.runId)
    const runs = await getDb().executionRuns.toArray()
    expect(runs.filter((run) => run.kind === "delegation")).toHaveLength(1)
  })

  it("drops milestones a re-plan abandoned instead of leaving them on the card", async () => {
    const { runId } = await acceptDelegation({
      delegationId: "d-4",
      title: "Re-plan",
      milestones: [
        { id: "m1", title: "Old A" },
        { id: "m2", title: "Old B" },
      ],
    })

    await reviseDelegationPlan({
      runId,
      version: 2,
      milestones: [{ id: "m3", title: "New only" }],
    })

    const snapshot = (await getExecutionRun(runId))?.latestSnapshot
    expect(snapshot?.pendingSteps.map((step) => step.title)).toEqual(["New only"])
    expect(snapshot?.planVersion).toBe(2)
  })

  it("adopts a run that started before anyone knew it would be delegated", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-5", title: "Adopt" })
    await createExecutionRun({
      id: "execution:agent-turn:t-1",
      kind: "agent-turn",
      sourceId: "t-1",
      title: "The turn",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })

    expect(await adoptIntoDelegation("execution:agent-turn:t-1", runId)).toBe(true)
    // Idempotent: a reconciler re-running must not churn the row.
    expect(await adoptIntoDelegation("execution:agent-turn:t-1", runId)).toBe(false)
    expect(await adoptIntoDelegation(runId, runId)).toBe(false)

    const children = await listDelegationChildren(runId)
    expect(children.map((child) => child.id)).toEqual(["execution:agent-turn:t-1"])
    expect(await hasActiveDelegationChild(runId)).toBe(true)

    await getDb().executionRuns.update("execution:agent-turn:t-1", { status: "completed" })
    expect(await hasActiveDelegationChild(runId)).toBe(false)
  })

  it("refuses to reopen a settled commitment", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-6", title: "Done" })
    await settleDelegation({ runId, status: "completed", summary: "All finished" })
    const revisionAfterSettle = (await getExecutionRun(runId))?.currentRevision

    await settleDelegation({ runId, status: "failed" })

    const run = await getExecutionRun(runId)
    expect(run?.status).toBe("completed")
    expect(run?.currentRevision).toBe(revisionAfterSettle)
    const terminal = (await listExecutionRunEvents(runId)).filter((event) =>
      event.type.startsWith("run.")
    )
    expect(terminal.map((event) => event.type)).toEqual(["run.started", "run.completed"])
  })
})
