/**
 * Tests for lib/db/outbound-jobs.ts — outbound delivery queue CRUD.
 */

import "fake-indexeddb/auto"
import {
  enqueueOutbound,
  pickNextDue,
  peekNextWakeAt,
  subscribeOutboundEnqueued,
  listPendingForConversation,
  markSending,
  markSent,
  markFailed,
  markDeadlettered,
  replayDeadlettered,
  type EnqueueInput,
} from "./outbound-jobs"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import type { OutboundRequest } from "@/types/connectors/outbound"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeRequest(idempotencyKey = crypto.randomUUID()): OutboundRequest {
  return {
    conversationRef: { platform: "telegram", adapterId: "adp_1" },
    segments: [{ type: "text", text: "hello" }],
    metadata: { idempotencyKey },
  }
}

// Test wrapper: defaults `source` to "ai-run" for the FIFO / queue-lifecycle
// tests that don't care about provenance. Tests that exercise the v41
// source/sourceWorkflow plumbing (see the "v41 — provenance" block below)
// call `enqueueOutbound` directly with explicit values.
function enqueue(input: Omit<EnqueueInput, "source"> & { source?: EnqueueInput["source"] }) {
  return enqueueOutbound({ source: "ai-run", ...input })
}

describe("outbound-jobs", () => {
  it("enqueueOutbound creates a pending row with correct defaults", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "telegram:adp_1:chat_1",
      request: makeRequest("key_1"),
    })
    expect(row.id).toMatch(/^oqj_/)
    expect(row.status).toBe("pending")
    expect(row.attempts).toBe(0)
    expect(row.nextAttemptAt).toBeGreaterThan(0)
    expect(row.idempotencyKey).toBe("key_1")
    expect(row.createdAt).toBeGreaterThan(0)
  })

  it("pickNextDue returns undefined when queue is empty", async () => {
    expect(await pickNextDue()).toBeUndefined()
  })

  it("pickNextDue returns the oldest pending row due now", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    const picked = await pickNextDue()
    expect(picked?.id).toBe(row.id)
  })

  it("pickNextDue does not return rows with nextAttemptAt in the future", async () => {
    await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
      nextAttemptAt: Date.now() + 60_000,
    })
    expect(await pickNextDue()).toBeUndefined()
  })

  it("pickNextDue picks the oldest due row across pending and failed, skipping sent", async () => {
    // Oldest is a failed (retry) row, then a pending one; a sent row that is
    // also "due in the past" must never be returned.
    const failedOld = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_A",
      request: makeRequest("k_failed"),
    })
    await new Promise((r) => setTimeout(r, 2))
    const pendingNewer = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_B",
      request: makeRequest("k_pending"),
    })
    await new Promise((r) => setTimeout(r, 2))
    const sentRow = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_C",
      request: makeRequest("k_sent"),
    })
    await markFailed(failedOld.id, "network", "retry", Date.now() - 1_000)
    await markSent(sentRow.id, "pm_sent")

    const picked = await pickNextDue()
    expect(picked?.id).toBe(failedOld.id)
    expect(picked?.status).toBe("failed")

    // Once the failed one is in flight, the pending row is next.
    await markSending(failedOld.id)
    const next = await pickNextDue()
    expect(next?.id).toBe(pendingNewer.id)
  })

  it("peekNextWakeAt returns the earliest future retry deadline, ignoring due-now rows", async () => {
    expect(await peekNextWakeAt()).toBeUndefined()

    // A row due now contributes nothing to the *future* wake.
    await enqueue({ adapterId: "adp_1", conversationKey: "conv_now", request: makeRequest() })
    expect(await peekNextWakeAt()).toBeUndefined()

    const soon = Date.now() + 5_000
    const later = Date.now() + 60_000
    await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_later",
      request: makeRequest("k_later"),
      nextAttemptAt: later,
    })
    await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_soon",
      request: makeRequest("k_soon"),
      nextAttemptAt: soon,
    })
    expect(await peekNextWakeAt()).toBe(soon)
  })

  it("enqueueOutbound fires the enqueued wake signal", async () => {
    let hits = 0
    const unsubscribe = subscribeOutboundEnqueued(() => {
      hits++
    })
    try {
      await enqueue({ adapterId: "adp_1", conversationKey: "conv_1", request: makeRequest() })
      await enqueue({ adapterId: "adp_1", conversationKey: "conv_2", request: makeRequest() })
      expect(hits).toBe(2)
    } finally {
      unsubscribe()
    }
    // After unsubscribe the handler must stop firing.
    await enqueue({ adapterId: "adp_1", conversationKey: "conv_3", request: makeRequest() })
    expect(hits).toBe(2)
  })

  it("listPendingForConversation returns FIFO order for conversation A", async () => {
    // Interleave jobs for A and B
    const a1 = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_A",
      request: makeRequest(),
    })
    await new Promise((r) => setTimeout(r, 1))
    const _b1 = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_B",
      request: makeRequest(),
    })
    await new Promise((r) => setTimeout(r, 1))
    const a2 = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_A",
      request: makeRequest(),
    })
    await new Promise((r) => setTimeout(r, 1))
    const _b2 = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_B",
      request: makeRequest(),
    })
    await new Promise((r) => setTimeout(r, 1))
    const a3 = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_A",
      request: makeRequest(),
    })

    const aJobs = await listPendingForConversation("conv_A")
    expect(aJobs).toHaveLength(3)
    expect(aJobs.map((j) => j.id)).toEqual([a1.id, a2.id, a3.id])
  })

  it("listPendingForConversation excludes non-pending rows", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    await markSending(row.id)
    const pending = await listPendingForConversation("conv_1")
    expect(pending).toHaveLength(0)
  })

  it("markSending transitions status to sending", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    await markSending(row.id)
    const updated = await getDb().outboundQueue.get(row.id)
    expect(updated?.status).toBe("sending")
    expect(updated?.attempts).toBe(1)
  })

  it("markSent transitions to sent with platformMessageId", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    await markSent(row.id, "platform_msg_999")
    const updated = await getDb().outboundQueue.get(row.id)
    expect(updated?.status).toBe("sent")
    expect(updated?.lastError).toBeUndefined()
  })

  it("markFailed sets failed status and nextAttemptAt", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    const nextAt = Date.now() + 5000
    await markFailed(row.id, "rate_limited", "Too many requests", nextAt)
    const updated = await getDb().outboundQueue.get(row.id)
    expect(updated?.status).toBe("failed")
    expect(updated?.lastErrorCode).toBe("rate_limited")
    expect(updated?.lastError).toBe("Too many requests")
    expect(updated?.nextAttemptAt).toBe(nextAt)
  })

  it("markDeadlettered sets deadlettered status", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    await markDeadlettered(row.id, "auth_failed", "Invalid token")
    const updated = await getDb().outboundQueue.get(row.id)
    expect(updated?.status).toBe("deadlettered")
    expect(updated?.lastErrorCode).toBe("auth_failed")
    expect(updated?.lastError).toBe("Invalid token")
  })

  it("replayDeadlettered re-arms a dead-lettered job and wakes the runner", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    await markDeadlettered(row.id, "auth_failed", "Invalid token")
    let woken = 0
    const unsub = subscribeOutboundEnqueued(() => {
      woken++
    })
    try {
      const replayed = await replayDeadlettered(row.id)
      expect(replayed?.status).toBe("pending")
      expect(replayed?.attempts).toBe(0)
      expect(replayed?.lastError).toBeUndefined()
      expect(replayed?.lastErrorCode).toBeUndefined()
      expect(replayed?.nextAttemptAt).toBeGreaterThan(0)
      const stored = await getDb().outboundQueue.get(row.id)
      expect(stored?.status).toBe("pending")
      // The replayed row is immediately due.
      expect(await pickNextDue()).toMatchObject({ id: row.id })
      expect(woken).toBeGreaterThan(0)
    } finally {
      unsub()
    }
  })

  it("replayDeadlettered refuses a non-dead-lettered row", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    // Still pending — replay must no-op.
    expect(await replayDeadlettered(row.id)).toBeUndefined()
    const stored = await getDb().outboundQueue.get(row.id)
    expect(stored?.status).toBe("pending")
  })

  it("replayDeadlettered returns undefined for a missing job", async () => {
    expect(await replayDeadlettered("oqj_missing")).toBeUndefined()
  })

  it("FIFO: 3 conv_A and 2 conv_B interleaved, conv_A returns in createdAt order", async () => {
    const jobs: { key: string; id: string }[] = []
    for (let i = 0; i < 5; i++) {
      const key = i % 2 === 0 ? "conv_A" : "conv_B"
      const row = await enqueue({
        adapterId: "adp_1",
        conversationKey: key,
        request: makeRequest(),
      })
      jobs.push({ key, id: row.id })
      await new Promise((r) => setTimeout(r, 1))
    }
    const aIds = jobs.filter((j) => j.key === "conv_A").map((j) => j.id)
    const queued = await listPendingForConversation("conv_A")
    expect(queued.map((j) => j.id)).toEqual(aIds)
  })

  // v41 — provenance plumbing (ADR-0009 v41 / im-a2ui-warm-eclipse plan).
  describe("v41 — provenance", () => {
    it.each(["ai-run", "manual", "workflow", "draft-approved"] as const)(
      "round-trips source=%s on the row",
      async (source) => {
        const row = await enqueueOutbound({
          adapterId: "adp_1",
          conversationKey: "conv_v41",
          request: makeRequest(`key_${source}`),
          source,
          ...(source === "workflow"
            ? {
                sourceWorkflow: {
                  workflowId: "wf_1",
                  runId: "run_1",
                  nodeId: "n_send_42",
                },
              }
            : {}),
        })
        const stored = await getDb().outboundQueue.get(row.id)
        expect(stored?.source).toBe(source)
        if (source === "workflow") {
          expect(stored?.sourceWorkflow).toEqual({
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "n_send_42",
          })
        } else {
          expect(stored?.sourceWorkflow).toBeUndefined()
        }
      }
    )

    it("ignores sourceWorkflow when source is not 'workflow'", async () => {
      const row = await enqueueOutbound({
        adapterId: "adp_1",
        conversationKey: "conv_v41_no_wf",
        request: makeRequest("key_no_wf"),
        source: "manual",
        sourceWorkflow: {
          workflowId: "wf_2",
          runId: "run_2",
          nodeId: "n_2",
        },
      })
      const stored = await getDb().outboundQueue.get(row.id)
      // Provenance enforcement: sourceWorkflow MUST be undefined when
      // source !== "workflow" so the inbox UI never renders a workflow
      // badge on a manually-typed message because of a stale field.
      expect(stored?.sourceWorkflow).toBeUndefined()
    })
  })

  // ── v49 — outboundQueue soft cap (inbox optimization plan) ──────────
  //
  // `enqueueOutbound` checks `count()` post-insert and, when above the
  // cap, ages the oldest pending rows to `deadlettered` with an audit
  // row per victim. Sending / failed / already-deadlettered rows are
  // preserved (in flight or terminal).
  describe("v49 — outboundQueue soft cap", () => {
    // Direct import inside the describe to keep test setup minimal and
    // avoid touching the outer module — the cap is a module-level const
    // so a single import is enough for the threshold assertions below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OUTBOUND_QUEUE_SOFT_CAP } = require("./outbound-jobs") as {
      OUTBOUND_QUEUE_SOFT_CAP: number
    }

    it("exports a 5000-row soft cap", () => {
      expect(OUTBOUND_QUEUE_SOFT_CAP).toBe(5000)
    })

    it("no-ops the cap enforcement when count <= cap", async () => {
      // Seed three rows; count is well under the cap, so no transitions
      // happen. We use the audit table count as a proxy: if the cap had
      // fired, the audit table would carry queue_capped rows.
      const before = await getDb().connectorAudit.count()
      for (let i = 0; i < 3; i++) {
        await enqueue({
          adapterId: "adp_under",
          conversationKey: `c_${i}`,
          request: makeRequest(`k_${i}`),
        })
      }
      const after = await getDb().connectorAudit.count()
      // No `outbound.queue_capped` rows should have been written.
      const capped = await getDb()
        .connectorAudit.where("kind")
        .equals("outbound.queue_capped")
        .count()
      expect(capped).toBe(0)
      // The audit table grew only via the cap enforcement; since no cap
      // fired, count delta must be zero.
      expect(after - before).toBe(0)
    })

    it("ages oldest pending row(s) to deadlettered + emits per-victim audit", async () => {
      // Force the cap to 3 via a temporary module mock would be ideal,
      // but the cap is a const for ergonomics. Instead, pre-seed rows
      // directly into Dexie so the table holds 5000 entries before the
      // next enqueue call. Each pre-seeded row uses unique createdAt so
      // FIFO ordering is deterministic.
      const db = getDb()
      const baseAt = Date.now() - 10_000_000
      const seedRows = Array.from({ length: 5000 }, (_, idx) => ({
        id: `seed-${idx}`,
        adapterId: "adp_full",
        conversationKey: `c_${idx}`,
        request: makeRequest(`seed_${idx}`),
        status: "pending" as const,
        attempts: 0,
        createdAt: baseAt + idx,
        nextAttemptAt: baseAt + idx,
        idempotencyKey: `seed_${idx}`,
        source: "ai-run" as const,
      }))
      await db.outboundQueue.bulkAdd(seedRows)
      expect(await db.outboundQueue.count()).toBe(5000)

      // The next enqueue pushes the table to 5001 → cap fires → the
      // oldest pending row (`seed-0`) is aged to `deadlettered`.
      await enqueue({
        adapterId: "adp_new",
        conversationKey: "c_new",
        request: makeRequest("k_new"),
      })

      const victim = await db.outboundQueue.get("seed-0")
      expect(victim?.status).toBe("deadlettered")
      expect(victim?.lastErrorCode).toBe("queue_capped")
      // Total count stays at 5001 — aging changes status, not row count.
      // The cap throttles pending growth; aged rows are preserved so the
      // operator can inspect them via the Outbound tab. The pending
      // count is the number to watch — it stayed at 5000 (the cap value).
      expect(await db.outboundQueue.count()).toBe(5001)
      const pendingCount = await db.outboundQueue.filter((r) => r.status === "pending").count()
      expect(pendingCount).toBe(5000)

      // Audit row was written for the aged victim.
      const audit = await db.connectorAudit.where("kind").equals("outbound.queue_capped").toArray()
      expect(audit).toHaveLength(1)
      expect(audit[0].adapterId).toBe("adp_full")
      expect(audit[0].fields?.jobId).toBe("seed-0")
      expect(typeof audit[0].fields?.ageMs).toBe("number")
    })

    it("does not age sending or already-deadlettered rows", async () => {
      // Pre-seed a row in `sending` status (in flight) and another in
      // `deadlettered` (terminal). Both must survive the cap enforcement.
      const db = getDb()
      const baseAt = Date.now() - 10_000_000
      const seedRows = Array.from({ length: 4998 }, (_, idx) => ({
        id: `bulk-${idx}`,
        adapterId: "adp_mix",
        conversationKey: `c_${idx}`,
        request: makeRequest(`bulk_${idx}`),
        status: "pending" as const,
        attempts: 0,
        createdAt: baseAt + 1000 + idx,
        nextAttemptAt: baseAt + 1000 + idx,
        idempotencyKey: `bulk_${idx}`,
        source: "ai-run" as const,
      }))
      // The "sending" + "deadlettered" rows have the OLDEST createdAt —
      // if the FIFO logic naïvely picked the oldest createdAt without
      // status filtering, these would be the first victims. They MUST
      // be skipped.
      await db.outboundQueue.bulkAdd([
        {
          id: "in-flight",
          adapterId: "adp_mix",
          conversationKey: "c_in_flight",
          request: makeRequest("in_flight"),
          status: "sending",
          attempts: 1,
          createdAt: baseAt,
          nextAttemptAt: baseAt,
          idempotencyKey: "in_flight",
          source: "ai-run",
        },
        {
          id: "already-dead",
          adapterId: "adp_mix",
          conversationKey: "c_dead",
          request: makeRequest("dead"),
          status: "deadlettered",
          attempts: 5,
          createdAt: baseAt + 1,
          nextAttemptAt: baseAt + 1,
          idempotencyKey: "dead",
          source: "ai-run",
          lastErrorCode: "max_retries",
          lastError: "gave up",
        },
        ...seedRows,
      ])
      expect(await db.outboundQueue.count()).toBe(5000)

      // Trip the cap with one more enqueue.
      await enqueue({
        adapterId: "adp_overflow",
        conversationKey: "c_overflow",
        request: makeRequest("overflow"),
      })

      expect((await db.outboundQueue.get("in-flight"))?.status).toBe("sending")
      expect((await db.outboundQueue.get("already-dead"))?.status).toBe("deadlettered")
      // The actual victim is the oldest PENDING row — `bulk-0`.
      expect((await db.outboundQueue.get("bulk-0"))?.status).toBe("deadlettered")
      expect((await db.outboundQueue.get("bulk-0"))?.lastErrorCode).toBe("queue_capped")
    })
  })
})
