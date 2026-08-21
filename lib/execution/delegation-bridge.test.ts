/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createExecutionRun,
  getExecutionRun,
  listExecutionRunEvents,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import type { ExecutionRunStatus } from "@/types/execution/run"

import { acceptDelegation } from "./delegation"
import {
  delegationStepId,
  maybeSettleDelegation,
  reconcileDelegationRuns,
  syncDelegationChildren,
} from "./delegation-bridge"

jest.mock("@/lib/db/connector-conversation-state", () => ({
  getConnectorConversationState: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: jest.fn(async () => undefined),
}))

async function child(input: {
  id: string
  parentRunId: string
  status: ExecutionRunStatus
  title?: string
  startedAt?: number
}): Promise<void> {
  await createExecutionRun({
    id: input.id,
    parentRunId: input.parentRunId,
    kind: "agent-turn",
    sourceId: input.id,
    title: input.title ?? input.id,
    status: input.status,
    currentRevision: 0,
    startedAt: input.startedAt ?? 1,
    updatedAt: input.startedAt ?? 1,
  })
}

describe("delegation bridge", () => {
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

  it("projects every child onto ONE card, in the order work was taken on", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-1", title: "Parent" })
    await child({
      id: "c-2",
      parentRunId: runId,
      status: "completed",
      title: "Second",
      startedAt: 20,
    })
    await child({ id: "c-1", parentRunId: runId, status: "running", title: "First", startedAt: 10 })

    await syncDelegationChildren(runId)

    const snapshot = (await getExecutionRun(runId))?.latestSnapshot
    expect(snapshot?.activeSteps.map((step) => step.title)).toEqual(["First"])
    expect(snapshot?.recentSteps.map((step) => step.title)).toEqual(["Second"])
    // One binding's worth of milestones, not one card per child.
    expect(snapshot?.progress.completed).toBe(1)
  })

  it("emits each child state exactly once no matter how often it reconciles", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-2", title: "Parent" })
    await child({ id: "c-1", parentRunId: runId, status: "running" })

    expect(await syncDelegationChildren(runId)).toBe(1)
    // Replay safety comes from the journal's own idempotency, not from the
    // bridge remembering what it sent — which is what lets it work after a
    // crash it never observed.
    expect(await syncDelegationChildren(runId)).toBe(1)
    const stepEvents = (await listExecutionRunEvents(runId)).filter((event) =>
      event.type.startsWith("step.")
    )
    expect(stepEvents).toHaveLength(1)
    expect(stepEvents[0]?.payload.stepId).toBe(delegationStepId("c-1"))
  })

  it("does not close a delegation parked on a human", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-3", title: "Parent" })
    await child({ id: "c-1", parentRunId: runId, status: "completed" })
    await getDb().executionRunInterrupts.add({
      id: "i-1",
      runId,
      type: "human_handoff",
      status: "pending",
      title: "Handed to Dana",
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    })

    expect(await maybeSettleDelegation(runId)).toBe(false)
    expect((await getExecutionRun(runId))?.status).not.toBe("completed")
  })

  it("closes on the LATEST attempt, so a retry after a failure still succeeds", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-4", title: "Parent" })
    await child({ id: "c-fail", parentRunId: runId, status: "failed", startedAt: 10 })
    await child({ id: "c-ok", parentRunId: runId, status: "completed", startedAt: 20 })
    await getDb().executionRuns.update("c-fail", { updatedAt: 100 })
    await getDb().executionRuns.update("c-ok", { updatedAt: 200 })

    expect(await maybeSettleDelegation(runId)).toBe(true)
    expect((await getExecutionRun(runId))?.status).toBe("completed")
  })

  it("stays open while any child can still act", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-5", title: "Parent" })
    await child({ id: "c-1", parentRunId: runId, status: "completed" })
    await child({ id: "c-2", parentRunId: runId, status: "running" })

    expect(await maybeSettleDelegation(runId)).toBe(false)
    expect((await getExecutionRun(runId))?.status).toBe("running")
  })

  it("closes a withdrawn commitment even when there was never a child to stop", async () => {
    // The delegation control handler cannot settle inline: the control gate
    // still has to append `control.accepted`, and a terminal journal refuses
    // it. So the intent is recorded and read back here — which also survives a
    // crash between the two.
    const { runId } = await acceptDelegation({ delegationId: "d-6", title: "Parent" })
    await runEventJournal.append(
      runId,
      semanticRunEvent("control.accepted", { action: "stop", actorId: "u-1" })
    )

    expect(await maybeSettleDelegation(runId)).toBe(true)
    expect((await getExecutionRun(runId))?.status).toBe("cancelled")
  })

  it("reconciles every open delegation and leaves settled ones alone", async () => {
    const open = await acceptDelegation({ delegationId: "d-7", title: "Open" })
    const done = await acceptDelegation({ delegationId: "d-8", title: "Done" })
    await child({ id: "c-open", parentRunId: open.runId, status: "running" })
    await child({ id: "c-done", parentRunId: done.runId, status: "completed" })

    const first = await reconcileDelegationRuns()
    expect(first.synced).toBe(2)
    expect(first.settled).toBe(1)

    const second = await reconcileDelegationRuns()
    // The settled one is skipped entirely; the open one re-emits nothing new.
    expect(second.synced).toBe(1)
    expect(second.settled).toBe(0)
  })
})
