/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  getExecutionRun,
  listExecutionRunEvents,
  putExecutionRunBinding,
} from "@/lib/db/execution-runs"

import { acceptDelegation, reviseDelegationPlan } from "./delegation"
import {
  buildDelegationHandoffBrief,
  handOffDelegationToHuman,
  markOverdueHandoffs,
  renderHandoffBrief,
  resumeDelegationHandoff,
} from "./delegation-handoff"
import { recoverPendingRunInterrupts } from "./run-control"

const setAssignee = jest.fn(async () => undefined)
jest.mock("@/lib/db/conversation-overrides", () => ({
  setAssignee: (...args: unknown[]) => setAssignee(...(args as [])),
  readForResolution: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/connector-conversation-state", () => ({
  getConnectorConversationState: jest.fn(async () => undefined),
}))

async function bind(runId: string): Promise<void> {
  const now = Date.now()
  await putExecutionRunBinding({
    id: `binding:${runId}`,
    runId,
    adapterId: "adapter-1",
    conversationKey: "adapter-1:conv-1",
    status: "active",
    deliveryMode: "native",
    lastProjectedRevision: 0,
    createdAt: now,
    updatedAt: now,
  })
}

describe("delegation handoff", () => {
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

  it("builds the brief out of what the run already knows", async () => {
    const { runId } = await acceptDelegation({
      delegationId: "d-1",
      title: "Migrate the billing service",
      initiator: { displayName: "Dana", remoteUserId: "u-dana" },
      milestones: [
        { id: "m1", title: "Inventory the callers" },
        { id: "m2", title: "Write the shim" },
        { id: "m3", title: "Cut over" },
      ],
    })
    await reviseDelegationPlan({
      runId,
      version: 2,
      milestones: [
        { id: "m1", title: "Inventory the callers" },
        { id: "m2", title: "Write the shim" },
        { id: "m3", title: "Cut over" },
      ],
    })
    const { runEventJournal, semanticRunEvent } = await import("@/lib/db/execution-runs")
    await runEventJournal.append(
      runId,
      semanticRunEvent("step.completed", {
        stepId: "m1",
        title: "Inventory the callers",
        safeTitle: true,
      })
    )
    await runEventJournal.append(
      runId,
      semanticRunEvent("step.started", { stepId: "m2", title: "Write the shim", safeTitle: true })
    )

    const brief = await buildDelegationHandoffBrief(runId)

    expect(brief?.requestedBy?.displayName).toBe("Dana")
    expect(brief?.done.map((step) => step.title)).toEqual(["Inventory the callers"])
    expect(brief?.inFlight.map((step) => step.title)).toEqual(["Write the shim"])
    expect(brief?.notStarted.map((step) => step.title)).toEqual(["Cut over"])
  })

  it("keeps the last failure message out of the IM rendering", async () => {
    // `snapshot.error` is the last failure message and can carry a stack. The
    // stopped-run note every platform receives already refuses to print it, and
    // a brief that leaks it would undo that on twelve platforms at once.
    const { runId } = await acceptDelegation({ delegationId: "d-2", title: "Task" })
    const { runEventJournal, semanticRunEvent } = await import("@/lib/db/execution-runs")
    await runEventJournal.append(
      runId,
      semanticRunEvent("run.waiting", { reason: "Needs a decision" })
    )
    const brief = (await buildDelegationHandoffBrief(runId))!
    const withError = {
      ...brief,
      blockedOn: { ...brief.blockedOn, error: "at Object.<anonymous>" },
    }

    expect(renderHandoffBrief(withError, { imSafe: true })).not.toContain("at Object.<anonymous>")
    expect(renderHandoffBrief(withError)).toContain("at Object.<anonymous>")
  })

  it("parks the delegation without terminating it", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-3", title: "Task" })
    await bind(runId)
    const deliverBrief = jest.fn(async () => undefined)

    const outcome = await handOffDelegationToHuman({
      runId,
      assignee: { kind: "human", id: "u-dana", label: "Dana" },
      deliverBrief,
    })

    expect(outcome.handedOff).toBe(true)
    const run = await getExecutionRun(runId)
    // Still open — the commitment did not end, it changed hands.
    expect(["waiting", "running"]).toContain(run?.status)
    expect(deliverBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `delegation-handoff:${runId}:${outcome.interruptId}`,
      })
    )
    expect(setAssignee).toHaveBeenCalledWith(
      "adapter-1:conv-1",
      { kind: "human", id: "u-dana", label: "Dana" },
      expect.objectContaining({ via: "delegation-handoff" })
    )
  })

  it("refuses a second handoff instead of stacking two owners", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-4", title: "Task" })
    await bind(runId)
    await handOffDelegationToHuman({ runId, assignee: { kind: "human", label: "Dana" } })

    const second = await handOffDelegationToHuman({
      runId,
      assignee: { kind: "human", label: "Sam" },
    })
    expect(second).toEqual({ handedOff: false, reason: "already_handed_off" })
  })

  it("compensates when assigning fails, rather than parking on a person nobody told", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-5", title: "Task" })
    await bind(runId)
    setAssignee.mockRejectedValueOnce(new Error("write failed"))

    await expect(
      handOffDelegationToHuman({ runId, assignee: { kind: "human", label: "Dana" } })
    ).rejects.toThrow("write failed")

    const interrupts = await getDb().executionRunInterrupts.toArray()
    expect(interrupts.every((interrupt) => interrupt.status !== "pending")).toBe(true)
    const types = (await listExecutionRunEvents(runId)).map((event) => event.type)
    expect(types).toContain("run.resumed")
  })

  it("hands back by resolving the interrupt and clearing the assignee", async () => {
    const { runId } = await acceptDelegation({ delegationId: "d-6", title: "Task" })
    await bind(runId)
    const { interruptId } = await handOffDelegationToHuman({
      runId,
      assignee: { kind: "human", label: "Dana" },
    })

    const result = await resumeDelegationHandoff({ runId, interruptId: interruptId! })

    expect(result.resumed).toBe(true)
    expect((await getDb().executionRunInterrupts.get(interruptId!))?.status).toBe("approved")
    // Clearing the assignee is what runs `setAssignee`'s own restore path for
    // the mode and routing the assignment had overridden.
    expect(setAssignee).toHaveBeenLastCalledWith(
      "adapter-1:conv-1",
      null,
      expect.objectContaining({ via: "delegation-handoff-return" })
    )
  })

  it("marks an overdue handoff instead of expiring it out from under the person", async () => {
    // Expiring would silently un-assign work someone still owns and resume an
    // agent on a task they are mid-way through.
    const { runId } = await acceptDelegation({ delegationId: "d-7", title: "Task" })
    await bind(runId)
    const { interruptId } = await handOffDelegationToHuman({
      runId,
      assignee: { kind: "human", label: "Dana" },
      slaMs: 1,
      now: 1_000,
    })

    await recoverPendingRunInterrupts(10_000)

    expect((await getDb().executionRunInterrupts.get(interruptId!))?.status).toBe("pending")
    const types = (await listExecutionRunEvents(runId)).map((event) => event.type)
    expect(types).toContain("run.degraded")

    // Idempotent: a second sweep says it once, not once per tick.
    const marked = await markOverdueHandoffs(20_000)
    expect(marked).toBe(1)
    const degraded = (await listExecutionRunEvents(runId)).filter(
      (event) => event.type === "run.degraded"
    )
    expect(degraded).toHaveLength(1)
  })
})
