import "fake-indexeddb/auto"

import { FusionDB } from "./fusion-db"
import { drainFusionOutbox, type OutboxAppliers } from "./outbox"
import type { FusionOutboxRow } from "./types"

let counter = 0
function freshDb(): FusionDB {
  return new FusionDB(`fusion-outbox-test-${++counter}`)
}

function effect(
  effectId: string,
  createdAt: number,
  kind: FusionOutboxRow["kind"] = "usage_row"
): FusionOutboxRow {
  return {
    effectId,
    runId: "run-1",
    kind,
    payload: { n: createdAt },
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt,
    appliedAt: null,
  }
}

describe("drainFusionOutbox", () => {
  it("applies pending effects in creation order and marks them", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd([
      effect("b", 2),
      effect("a", 1),
      effect("c", 3, "execution_run_milestone"),
    ])
    const seen: string[] = []
    const appliers: OutboxAppliers = {
      usage_row: async (row) => {
        seen.push(row.effectId)
        return "applied"
      },
      execution_run_milestone: async (row) => {
        seen.push(row.effectId)
        return "skipped"
      },
      execution_run_projection: async (row) => {
        seen.push(row.effectId)
        return "applied"
      },
      session_message: async () => "applied",
    }
    expect(await drainFusionOutbox(db, appliers, { now: () => 99 })).toEqual({
      applied: 2,
      skipped: 1,
      failed: 0,
    })
    expect(seen).toEqual(["a", "b", "c"])
    expect(await db.fusionOutbox.get("a")).toMatchObject({
      status: "applied",
      attempts: 1,
      appliedAt: 99,
    })
    expect((await db.fusionOutbox.get("c"))?.status).toBe("skipped")
    expect(await drainFusionOutbox(db, appliers)).toEqual({ applied: 0, skipped: 0, failed: 0 })
  })

  it("keeps a failing effect pending with its error and retries it later", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("a", 1))
    let fail = true
    const appliers: OutboxAppliers = {
      usage_row: async () => {
        if (fail) throw new Error("account db closed")
        return "applied"
      },
      execution_run_milestone: async () => "applied",
      execution_run_projection: async () => "applied",
      session_message: async () => "applied",
    }
    expect((await drainFusionOutbox(db, appliers)).failed).toBe(1)
    expect(await db.fusionOutbox.get("a")).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "account db closed",
    })
    fail = false
    expect((await drainFusionOutbox(db, appliers)).applied).toBe(1)
  })

  it("[ACC:ISO-05] yields each effect once across a crash between apply and mark", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("usage:attempt-1", 1))
    // The target of an idempotent applier: keyed by effect, replace-in-place.
    const target = new Map<string, number>()
    const appliers: OutboxAppliers = {
      usage_row: async (row) => {
        target.set(row.effectId, (row.payload as { n: number }).n)
        return "applied"
      },
      execution_run_milestone: async () => "applied",
      execution_run_projection: async () => "applied",
      session_message: async () => "applied",
    }
    // Crash window: the effect lands, the status update does not.
    const update = db.fusionOutbox.update.bind(db.fusionOutbox)
    const spy = jest
      .spyOn(db.fusionOutbox, "update")
      .mockImplementationOnce((() => Promise.reject(new Error("tab closed"))) as never)
    expect((await drainFusionOutbox(db, appliers)).failed).toBe(1)
    spy.mockImplementation(update)
    expect(await db.fusionOutbox.get("usage:attempt-1")).toMatchObject({
      status: "pending",
      lastError: "tab closed",
    })
    // Replay on the next boot.
    await drainFusionOutbox(db, appliers)
    expect([...target.entries()]).toEqual([["usage:attempt-1", 1]])
    expect((await db.fusionOutbox.get("usage:attempt-1"))?.status).toBe("applied")
    spy.mockRestore()
  })

  it("hands an applier the store's artifacts, and a drain without them keeps the effect pending", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("session:run-1:answer", 1, "session_message"))
    const read: string[] = []
    const appliers: OutboxAppliers = {
      usage_row: async () => "applied",
      execution_run_milestone: async () => "applied",
      execution_run_projection: async () => "applied",
      session_message: async (_row, context) => {
        const content = await context.readArtifact("answer-artifact")
        read.push(String(content))
        return "applied"
      },
    }
    expect((await drainFusionOutbox(db, appliers)).failed).toBe(1)
    expect((await db.fusionOutbox.get("session:run-1:answer"))?.lastError).toContain(
      "no artifact reader"
    )

    const drained = await drainFusionOutbox(db, appliers, {
      readArtifact: async (id) => (id === "answer-artifact" ? "the answer" : null),
    })
    expect(drained.applied).toBe(1)
    expect(read).toEqual(["the answer"])
  })

  it("joins a drain that is already running instead of applying twice", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("a", 1))
    let calls = 0
    const appliers: OutboxAppliers = {
      usage_row: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return "applied"
      },
      execution_run_milestone: async () => "applied",
      execution_run_projection: async () => "applied",
      session_message: async () => "applied",
    }
    const [first, second] = await Promise.all([
      drainFusionOutbox(db, appliers),
      drainFusionOutbox(db, appliers),
    ])
    expect(calls).toBe(1)
    expect(first).toBe(second)
  })
})
