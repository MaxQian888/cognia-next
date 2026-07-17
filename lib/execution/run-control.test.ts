/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun } from "@/lib/db/execution-runs"
import {
  createRunInterrupt,
  executeRunControlCommand,
  recoverPendingRunInterrupts,
  registerRunControlHandler,
} from "./run-control"

describe("execution run controls", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  async function seed(): Promise<void> {
    await createExecutionRun({
      id: "run-1",
      kind: "agent-turn",
      sourceId: "turn-1",
      title: "Agent",
      status: "running",
      initiator: { remoteUserId: "owner" },
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
  }

  it("allows only the initiator or configured operators", async () => {
    await seed()
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const denied = await executeRunControlCommand(
      {
        runId: "run-1",
        action: "stop",
        idempotencyKey: "cmd-denied",
        expectedRevision: 1,
        actor: { remoteUserId: "stranger" },
      },
      { operatorIds: ["operator"] }
    )
    const accepted = await executeRunControlCommand(
      {
        runId: "run-1",
        action: "stop",
        idempotencyKey: "cmd-operator",
        expectedRevision: 1,
        actor: { remoteUserId: "operator" },
      },
      { operatorIds: ["operator"] }
    )

    expect(denied).toMatchObject({ accepted: false, reason: "forbidden" })
    expect(accepted.accepted).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    unregister()
  })

  it("deduplicates callbacks and rejects stale optimistic revisions", async () => {
    await seed()
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)
    const command = {
      runId: "run-1",
      action: "pause" as const,
      idempotencyKey: "same-callback",
      expectedRevision: 0,
      actor: { remoteUserId: "owner" },
    }

    const first = await executeRunControlCommand(command)
    const duplicate = await executeRunControlCommand(command)
    const stale = await executeRunControlCommand({
      ...command,
      idempotencyKey: "stale",
      expectedRevision: 0,
    })

    expect(first.accepted).toBe(true)
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true })
    expect(stale).toMatchObject({ accepted: false, reason: "revision_conflict" })
    expect(handler).toHaveBeenCalledTimes(1)
    unregister()
  })

  it("serializes concurrent controls so only one matching revision reaches the source", async () => {
    await seed()
    const handler = jest.fn(async () => Promise.resolve())
    const unregister = registerRunControlHandler("agent-turn", handler)
    const command = (idempotencyKey: string) => ({
      runId: "run-1",
      action: "stop" as const,
      idempotencyKey,
      expectedRevision: 0,
      actor: { remoteUserId: "owner" },
    })

    const results = await Promise.all([
      executeRunControlCommand(command("concurrent-1")),
      executeRunControlCommand(command("concurrent-2")),
    ])

    expect(results.filter((result) => result.accepted)).toHaveLength(1)
    expect(results).toContainEqual(expect.objectContaining({ reason: "revision_conflict" }))
    expect(handler).toHaveBeenCalledTimes(1)
    unregister()
  })

  it("expires approvals without executing a source handler", async () => {
    await seed()
    await createRunInterrupt({
      id: "interrupt-1",
      runId: "run-1",
      type: "tool_approval",
      status: "pending",
      title: "Run shell command",
      expiresAt: 10,
      createdAt: 1,
    })
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const result = await executeRunControlCommand(
      {
        runId: "run-1",
        action: "approve",
        idempotencyKey: "approval",
        expectedRevision: 1,
        actor: { remoteUserId: "owner" },
        interruptId: "interrupt-1",
      },
      { now: 11 }
    )

    expect(result).toMatchObject({ accepted: false, reason: "interrupt_expired" })
    expect(handler).not.toHaveBeenCalled()
    expect(await getDb().executionRunInterrupts.get("interrupt-1")).toMatchObject({
      status: "expired",
    })
    unregister()
  })

  it("marks a non-expired agent approval as recovery-required after restart", async () => {
    await seed()
    await createRunInterrupt({
      id: "interrupt-restart",
      runId: "run-1",
      type: "tool_approval",
      status: "pending",
      title: "Run shell command",
      expiresAt: 100,
      createdAt: 1,
    })

    await recoverPendingRunInterrupts(50)

    expect(await getDb().executionRuns.get("run-1")).toMatchObject({
      status: "recovery_required",
    })
  })
})
