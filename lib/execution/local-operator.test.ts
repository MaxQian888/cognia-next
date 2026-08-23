/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun } from "@/lib/db/execution-runs"
import { executeRunControlCommand, registerRunControlHandler } from "./run-control"
import {
  LOCAL_CONSOLE_ACTOR_ID,
  localConsoleActor,
  localConsoleOperatorIds,
} from "./local-operator"

describe("local console operator identity", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  /** A locally-started run: no initiator, exactly as every local producer writes it. */
  async function seedLocalRun(): Promise<void> {
    await createExecutionRun({
      id: "run-local",
      kind: "agent-turn",
      sourceId: "turn-local",
      title: "Chat run",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
  }

  it("namespaces the id so no platform user id can collide with it", () => {
    expect(LOCAL_CONSOLE_ACTOR_ID).toBe("cognia:local-console")
    expect(localConsoleActor().platformIdentityId).toBe(LOCAL_CONSOLE_ACTOR_ID)
    // Never the remote field: nothing about this actor is remote, and using it
    // would misreport provenance in `control.accepted`.
    expect(localConsoleActor().remoteUserId).toBeUndefined()
    expect(localConsoleOperatorIds()).toEqual([LOCAL_CONSOLE_ACTOR_ID])
  })

  /**
   * The regression this module exists for: without the operator grant the gate
   * refuses, because a local run records no initiator to match against.
   */
  it("is forbidden on a local run WITHOUT the operator grant", async () => {
    await seedLocalRun()
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const result = await executeRunControlCommand({
      runId: "run-local",
      action: "stop",
      idempotencyKey: "k1",
      expectedRevision: 0,
      actor: localConsoleActor(),
    })

    expect(result).toMatchObject({ accepted: false, reason: "forbidden" })
    expect(handler).not.toHaveBeenCalled()
    unregister()
  })

  it("authorizes a local run WITH the operator grant", async () => {
    await seedLocalRun()
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const result = await executeRunControlCommand(
      {
        runId: "run-local",
        action: "stop",
        idempotencyKey: "k2",
        expectedRevision: 0,
        actor: localConsoleActor("Alex"),
      },
      { operatorIds: [...localConsoleOperatorIds()] }
    )

    expect(result.accepted).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    unregister()
  })

  /**
   * The grant must not be a skeleton key: it authorizes the local actor, not
   * whoever happens to be holding the command.
   */
  it("does not authorize some other actor just because the grant is present", async () => {
    await seedLocalRun()
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const result = await executeRunControlCommand(
      {
        runId: "run-local",
        action: "stop",
        idempotencyKey: "k3",
        expectedRevision: 0,
        actor: { remoteUserId: "someone-else" },
      },
      { operatorIds: [...localConsoleOperatorIds()] }
    )

    expect(result).toMatchObject({ accepted: false, reason: "forbidden" })
    expect(handler).not.toHaveBeenCalled()
    unregister()
  })

  it("controls a run a REMOTE user initiated — it still executes on this machine", async () => {
    await createExecutionRun({
      id: "run-remote",
      kind: "agent-turn",
      sourceId: "turn-remote",
      title: "Delegated run",
      status: "running",
      initiator: { remoteUserId: "lark-user-9" },
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const result = await executeRunControlCommand(
      {
        runId: "run-remote",
        action: "stop",
        idempotencyKey: "k4",
        expectedRevision: 0,
        actor: localConsoleActor(),
      },
      { operatorIds: [...localConsoleOperatorIds()] }
    )

    expect(result.accepted).toBe(true)
    unregister()
  })
})
