/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createRunInterrupt, executeRunControlCommand } from "@/lib/execution/run-control"
import { registerRunControlHandler } from "@/lib/execution/run-control"
import { localConsoleActor, localConsoleOperatorIds } from "@/lib/execution/local-operator"
import type { ExecutionRunInterrupt, RunControlCommand } from "@/types/execution/run"
import { createSquadRunRecords } from "./squad-run-records"
import {
  listPendingSquadReviews,
  openSquadReview,
  sanitizeDecision,
  settleSquadReview,
  settleSquadReviewFromControl,
  squadReviewInterruptIdFor,
  squadReviewRequestIdFromInterrupt,
} from "./squad-review-gate"

const RUN = "run_team_gate01"
const EXECUTION = `execution:team:${RUN}`

type Listener = (row: ExecutionRunInterrupt | undefined) => void
const listeners = new Map<string, Set<Listener>>()
const subscribe = (interruptId: string, listener: Listener) => {
  const set = listeners.get(interruptId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(interruptId, set)
  return () => set.delete(listener)
}
async function notify(interruptId: string): Promise<void> {
  const row = await getDb().executionRunInterrupts.get(interruptId)
  for (const listener of listeners.get(interruptId) ?? []) listener(row)
}

const deps = { subscribe, checkpoint: async () => undefined }

function controlCommand(
  interruptId: string,
  action: "approve" | "deny",
  reviewDecision?: RunControlCommand["reviewDecision"],
  revision = 2
): RunControlCommand {
  return {
    runId: EXECUTION,
    action,
    idempotencyKey: `t:${interruptId}:${action}:${Math.random()}`,
    expectedRevision: revision,
    actor: localConsoleActor("Tester"),
    interruptId,
    ...(reviewDecision ? { reviewDecision } : {}),
  }
}

describe("squad review gate", () => {
  let disableDbRuntime: (() => void) | undefined
  let unregister: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    listeners.clear()
    await createSquadRunRecords({
      runId: RUN,
      teamId: "team-1",
      projectId: "ws",
      objective: "o",
      origin: "chat",
      startedAt: 1_000,
    })
    // The real `team` handler lives in control-handlers. Here the gate is the
    // unit under test, so the handler is the gate's own control half.
    unregister = registerRunControlHandler("team", async (command) => {
      if (command.action === "approve" || command.action === "deny") {
        await settleSquadReviewFromControl(command, deps)
      }
    })
  })

  afterEach(async () => {
    unregister?.()
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("opens one durable interrupt with the review kind and subject, parking the run", async () => {
    const pending = openSquadReview(
      {
        runId: RUN,
        teamId: "team-1",
        projectId: "ws",
        kind: "plan",
        instance: "revision-0",
        subject: { revision: 0 },
      },
      deps
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const id = squadReviewInterruptIdFor(RUN, "plan", "revision-0")
    const row = await getDb().executionRunInterrupts.get(id)
    expect(row).toMatchObject({
      runId: EXECUTION,
      type: "plan_approval",
      status: "pending",
      reviewKind: "plan",
      subject: { revision: 0 },
      projectId: "ws",
    })
    const run = await getDb().executionRuns.get(EXECUTION)
    expect(run?.status).toBe("waiting")
    expect(run?.latestSnapshot?.allowedActions).toEqual(expect.arrayContaining(["approve", "deny"]))
    expect(run?.latestSnapshot?.pendingInterrupt).toMatchObject({ type: "plan_approval" })

    // Settle through the control plane, as a person would.
    const result = await executeRunControlCommand(
      controlCommand(id, "approve", { kind: "plan" }, run!.currentRevision),
      { operatorIds: [...localConsoleOperatorIds()] }
    )
    expect(result).toEqual({ accepted: true, currentRevision: expect.any(Number) })
    await notify(id)
    await expect(pending).resolves.toEqual({ kind: "plan", outcome: "approve" })
    expect((await listPendingSquadReviews(RUN)).length).toBe(0)
  })

  it("delivers the typed payload and redacts plan feedback before persisting it", async () => {
    const pending = openSquadReview(
      { runId: RUN, teamId: "team-1", kind: "plan", instance: "revision-1" },
      deps
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const id = squadReviewInterruptIdFor(RUN, "plan", "revision-1")
    const run = await getDb().executionRuns.get(EXECUTION)
    await executeRunControlCommand(
      controlCommand(
        id,
        "deny",
        { kind: "plan", feedback: "  ask alice@example.com first " },
        run!.currentRevision
      ),
      { operatorIds: [...localConsoleOperatorIds()] }
    )
    await notify(id)
    await expect(pending).resolves.toEqual({
      kind: "plan",
      outcome: "deny",
      feedback: "ask <EMAIL_001> first",
    })
    const row = await getDb().executionRunInterrupts.get(id)
    expect(row?.decision).toEqual({
      kind: "plan",
      outcome: "deny",
      feedback: "ask <EMAIL_001> first",
    })
    // Journals carry no free text.
    const events = await getDb().executionRunEvents.where("runId").equals(EXECUTION).toArray()
    expect(JSON.stringify(events)).not.toContain("alice")
    expect(JSON.stringify(events)).not.toContain("EMAIL_001")
    // The receipt exists, under the plan channel.
    const receipts = await getDb().actionReviewReceipts.toArray()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      request: { origin: { channel: "agent-team-plan", runId: EXECUTION } },
      decision: { outcome: "deny", authority: "human" },
    })
  })

  it("refuses a mismatched or missing decision at the control gate", async () => {
    void openSquadReview(
      { runId: RUN, teamId: "team-1", kind: "budget_extension", instance: "crossing-1" },
      deps
    ).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const id = squadReviewInterruptIdFor(RUN, "budget_extension", "crossing-1")
    const run = await getDb().executionRuns.get(EXECUTION)
    const missing = await executeRunControlCommand(
      controlCommand(id, "approve", undefined, run!.currentRevision),
      { operatorIds: [...localConsoleOperatorIds()] }
    )
    expect(missing).toMatchObject({ accepted: false, reason: "invalid_command" })
    // A refusal is journalled, so the revision moved.
    const afterMissing = await getDb().executionRuns.get(EXECUTION)
    const mismatched = await executeRunControlCommand(
      controlCommand(
        id,
        "approve",
        { kind: "deadlock", resetAll: true },
        afterMissing!.currentRevision
      ),
      { operatorIds: [...localConsoleOperatorIds()] }
    )
    expect(mismatched).toMatchObject({ accepted: false, reason: "invalid_command" })
    expect((await getDb().executionRunInterrupts.get(id))?.status).toBe("pending")
  })

  /** Restart: the same gate instance finds its row and resumes exactly once. */
  it("returns a decision that landed while nobody was waiting", async () => {
    void openSquadReview(
      { runId: RUN, teamId: "team-1", kind: "deadlock", instance: "deadlock-1" },
      deps
    ).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const id = squadReviewInterruptIdFor(RUN, "deadlock", "deadlock-1")
    const run = await getDb().executionRuns.get(EXECUTION)
    const settled = await executeRunControlCommand(
      controlCommand(
        id,
        "approve",
        { kind: "deadlock", teammateIds: ["m1"] },
        run!.currentRevision
      ),
      { operatorIds: [...localConsoleOperatorIds()] }
    )
    expect(settled).toMatchObject({ accepted: true })
    // A fresh process re-arms the same gate: no new interrupt, immediate answer.
    const rearmed = await openSquadReview(
      { runId: RUN, teamId: "team-1", kind: "deadlock", instance: "deadlock-1" },
      deps
    )
    expect(rearmed).toEqual({ kind: "deadlock", outcome: "approve", teammateIds: ["m1"] })
    expect(await getDb().executionRunInterrupts.count()).toBe(1)
  })

  it("attaches to a still-pending row instead of opening a second one", async () => {
    const first = openSquadReview(
      { runId: RUN, teamId: "team-1", kind: "capability_audit", instance: "pre-run" },
      deps
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = openSquadReview(
      { runId: RUN, teamId: "team-1", kind: "capability_audit", instance: "pre-run" },
      deps
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await getDb().executionRunInterrupts.count()).toBe(1)
    const id = squadReviewInterruptIdFor(RUN, "capability_audit", "pre-run")
    const run = await getDb().executionRuns.get(EXECUTION)
    const settled = await executeRunControlCommand(
      controlCommand(id, "approve", undefined, run!.currentRevision),
      { operatorIds: [...localConsoleOperatorIds()] }
    )
    expect(settled).toMatchObject({ accepted: true })
    await notify(id)
    await expect(first).resolves.toMatchObject({ outcome: "approve" })
    await expect(second).resolves.toMatchObject({ outcome: "approve" })
  })

  it("lets a delegate answer first and settles the interrupt with its decision", async () => {
    const outcome = await openSquadReview(
      {
        runId: RUN,
        teamId: "team-1",
        kind: "plan",
        instance: "revision-2",
        delegate: async () => ({ kind: "plan", outcome: "approve" }),
      },
      deps
    )
    expect(outcome).toEqual({ kind: "plan", outcome: "approve" })
    const id = squadReviewInterruptIdFor(RUN, "plan", "revision-2")
    const row = await getDb().executionRunInterrupts.get(id)
    expect(row?.status).toBe("approved")
    expect(row?.decision).toEqual({ kind: "plan", outcome: "approve" })
    expect(await getDb().actionReviewReceipts.count()).toBe(1)
  })

  it("rejects the wait on abort and leaves the interrupt pending for a resume", async () => {
    const controller = new AbortController()
    const pending = openSquadReview(
      {
        runId: RUN,
        teamId: "team-1",
        kind: "plan",
        instance: "revision-3",
        signal: controller.signal,
      },
      deps
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort(new Error("paused"))
    await expect(pending).rejects.toThrow("paused")
    const id = squadReviewInterruptIdFor(RUN, "plan", "revision-3")
    expect((await getDb().executionRunInterrupts.get(id))?.status).toBe("pending")
  })

  it("treats an expired row as a deny", async () => {
    const id = squadReviewInterruptIdFor(RUN, "budget_extension", "crossing-9")
    await createRunInterrupt({
      id,
      runId: EXECUTION,
      type: "squad_budget",
      status: "expired",
      title: "budget_extension",
      expiresAt: 1,
      createdAt: 0,
      reviewKind: "budget_extension",
    })
    await expect(
      openSquadReview(
        { runId: RUN, teamId: "team-1", kind: "budget_extension", instance: "crossing-9" },
        deps
      )
    ).resolves.toEqual({ kind: "budget_extension", extraTokens: 0, outcome: "deny" })
  })

  it("parses its own interrupt ids and ignores foreign ones", () => {
    expect(
      squadReviewRequestIdFromInterrupt({
        id: squadReviewInterruptIdFor(RUN, "teammate_repair", "m:1"),
      })
    ).toEqual({ runId: RUN, kind: "teammate_repair", instance: "m:1" })
    expect(squadReviewRequestIdFromInterrupt({ id: "action-review:chat-tool:x" })).toBeUndefined()
    expect(squadReviewRequestIdFromInterrupt({ id: "interrupt-9" })).toBeUndefined()
  })

  it("only redacts the one free-text member", () => {
    const redact = jest.fn((text: string) => `<${text}>`)
    expect(sanitizeDecision({ kind: "plan", outcome: "deny", feedback: " hi " }, redact)).toEqual({
      kind: "plan",
      outcome: "deny",
      feedback: "<hi>",
    })
    expect(
      sanitizeDecision({ kind: "budget_extension", outcome: "approve", extraTokens: 5 }, redact)
    ).toEqual({ kind: "budget_extension", outcome: "approve", extraTokens: 5 })
    expect(redact).toHaveBeenCalledTimes(1)
  })

  it("settles from a source without a control command and writes the receipt once", async () => {
    void openSquadReview(
      { runId: RUN, teamId: "team-1", kind: "replan", instance: "after-t1" },
      deps
    ).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await settleSquadReview(
      { runId: RUN, kind: "replan", instance: "after-t1" },
      { kind: "replan", outcome: "approve" },
      { authority: "human", actorKind: "connector-user", actorId: "u1" },
      deps
    )
    await settleSquadReview(
      { runId: RUN, kind: "replan", instance: "after-t1" },
      { kind: "replan", outcome: "deny" },
      { authority: "human", actorKind: "connector-user", actorId: "u1" },
      deps
    )
    const id = squadReviewInterruptIdFor(RUN, "replan", "after-t1")
    const row = await getDb().executionRunInterrupts.get(id)
    expect(row?.status).toBe("approved")
    expect(row?.decision).toEqual({ kind: "replan", outcome: "approve" })
    expect(await getDb().actionReviewReceipts.count()).toBe(1)
  })
})
