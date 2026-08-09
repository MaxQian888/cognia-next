/**
 * Tests for lib/db/outbound-jobs.ts — outbound delivery queue CRUD.
 */

import {
  enqueueOutbound,
  enqueueOutboundMany,
  listDueNow,
  pickNextDue,
  peekNextWakeAt,
  subscribeOutboundEnqueued,
  listPendingForConversation,
  markSending,
  markSent,
  markFailed,
  markDeadlettered,
  replayDeadlettered,
  waitForOutboundTerminal,
  unclaimSending,
  recoverStaleSendingJobs,
  sweepTerminalOutboundRows,
  findDeliveredByIdempotencyKey,
  findOlderActiveOutboundSibling,
  findNextActiveOutboundSibling,
  OUTBOUND_TERMINAL_RETENTION_MS,
  OUTBOUND_DUE_BATCH_SIZE,
  STALE_SENDING_GRACE_MS,
  __setOutboundQueueSoftCapForTesting,
  type EnqueueInput,
} from "./outbound-jobs"
import { getDb } from "./schema"
import { saveSettings } from "./settings"
import { createDbTestFixture } from "./test-fixture"
import type { OutboundRequest } from "@/types/connectors/outbound"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize, 60_000)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

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
    expect(row.orderSeq).toBe(1)
  })

  it("enqueueOutboundMany keeps a stable FIFO for 1,000 same-millisecond jobs", async () => {
    const now = 123_456
    const requests = Array.from({ length: 1_001 }, (_, index) => ({
      adapterId: "adp_1",
      conversationKey: index === 1_000 ? "conv_other" : "conv_batch",
      request: makeRequest(`batch-${index}`),
      source: "workflow" as const,
    }))

    const rows = await enqueueOutboundMany(requests, { now })

    expect(new Set(rows.map((row) => row.createdAt))).toEqual(new Set([now]))
    expect(rows.slice(0, 1_000).map((row) => row.orderSeq)).toEqual(
      Array.from({ length: 1_000 }, (_, index) => index + 1)
    )
    expect(rows[1_000].orderSeq).toBe(1)
    const storedIds = (
      await getDb()
        .outboundQueue.where("[conversationKey+orderSeq]")
        .between(["conv_batch", 0], ["conv_batch", Infinity])
        .toArray()
    ).map((row) => row.id)
    expect(storedIds).toEqual(rows.slice(0, 1_000).map((row) => row.id))
  })

  it("bounds due reads and uses the injected clock", async () => {
    await enqueueOutboundMany(
      Array.from({ length: OUTBOUND_DUE_BATCH_SIZE + 20 }, (_, index) => ({
        adapterId: "adp_1",
        conversationKey: `conv-${index}`,
        request: makeRequest(`due-${index}`),
        source: "ai-run" as const,
        nextAttemptAt: 500,
      })),
      { now: 100 }
    )

    expect(await listDueNow({ now: 499 })).toHaveLength(0)
    expect(await listDueNow({ now: 500 })).toHaveLength(OUTBOUND_DUE_BATCH_SIZE)
    expect((await listDueNow({ now: 500, limit: 17 })).length).toBeLessThanOrEqual(17)
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

  it("markSending is an atomic claim: only the first caller wins", async () => {
    const row = await enqueue({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    const first = await markSending(row.id)
    const second = await markSending(row.id)
    expect(first).toBe(true)
    // Second claim loses — the row is already 'sending', not pending/failed.
    expect(second).toBe(false)
    const updated = await getDb().outboundQueue.get(row.id)
    // Attempts incremented exactly once (no double-send).
    expect(updated?.attempts).toBe(1)
  })

  it("markSending returns false for an unknown job id", async () => {
    expect(await markSending("nope")).toBe(false)
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

    let restoreSoftCap: () => void
    beforeEach(() => {
      restoreSoftCap = __setOutboundQueueSoftCapForTesting(3)
    })
    afterEach(() => restoreSoftCap())

    it("exports a 5000-row soft cap", () => {
      expect(OUTBOUND_QUEUE_SOFT_CAP).toBe(5000)
    })

    it("restricts the soft-cap override to valid test values", () => {
      expect(() => __setOutboundQueueSoftCapForTesting(0)).toThrow(/positive safe integer/)

      const mutableEnv = process.env as Record<string, string | undefined>
      const previous = mutableEnv.NODE_ENV
      mutableEnv.NODE_ENV = "production"
      try {
        expect(() => __setOutboundQueueSoftCapForTesting(2)).toThrow(/only available/)
      } finally {
        if (previous === undefined) {
          delete mutableEnv.NODE_ENV
        } else {
          mutableEnv.NODE_ENV = previous
        }
      }

      const restore = __setOutboundQueueSoftCapForTesting(2)
      restore()
      restore()
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
      // The test-only cap is 3. Pre-seed exactly three active rows so the
      // next enqueue crosses the boundary while preserving deterministic FIFO.
      const db = getDb()
      const baseAt = Date.now() - 10_000_000
      const seedRows = Array.from({ length: 3 }, (_, idx) => ({
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
      expect(await db.outboundQueue.count()).toBe(3)

      // The next enqueue pushes the table to 4 → cap fires → the
      // oldest pending row (`seed-0`) is aged to `deadlettered`.
      await enqueue({
        adapterId: "adp_new",
        conversationKey: "c_new",
        request: makeRequest("k_new"),
      })

      const victim = await db.outboundQueue.get("seed-0")
      expect(victim?.status).toBe("deadlettered")
      expect(victim?.lastErrorCode).toBe("queue_capped")
      // Total count stays at 4 — aging changes status, not row count.
      // The cap throttles pending growth; aged rows are preserved so the
      // operator can inspect them via the Outbound tab. The pending
      // count is the number to watch — it stayed at 3 (the test cap value).
      expect(await db.outboundQueue.count()).toBe(4)
      const pendingCount = await db.outboundQueue.filter((r) => r.status === "pending").count()
      expect(pendingCount).toBe(3)

      // Audit row was written for the aged victim.
      const audit = await db.connectorAudit.where("kind").equals("outbound.queue_capped").toArray()
      expect(audit).toHaveLength(1)
      expect(audit[0].adapterId).toBe("adp_full")
      expect(audit[0].fields?.jobId).toBe("seed-0")
      expect(typeof audit[0].fields?.ageMs).toBe("number")
    }, 120_000)

    it("does not age sending or already-deadlettered rows", async () => {
      // Pre-seed a row in `sending` status (in flight) and another in
      // `deadlettered` (terminal). Both must survive the cap enforcement.
      // Active rows = 2 pending + 1 sending (the deadlettered row is
      // terminal and does NOT count), so the next enqueue crosses the cap.
      const db = getDb()
      const baseAt = Date.now() - 10_000_000
      const seedRows = Array.from({ length: 2 }, (_, idx) => ({
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
      expect(await db.outboundQueue.count()).toBe(4)

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
    }, 120_000)
  })

  // ── P0 — the cap counts BACKLOG, not history ─────────────────────────
  describe("soft cap ignores terminal rows", () => {
    it("terminal rows alone above the cap never dead-letter a fresh enqueue", async () => {
      const restoreSoftCap = __setOutboundQueueSoftCapForTesting(3)
      try {
        // Four terminal rows (the pre-fix bug: these counted against the cap,
        // so this seed alone would have dead-lettered EVERY new enqueue —
        // total outbound outage). With the fix only active rows count.
        const db = getDb()
        const baseAt = Date.now() - 10_000_000
        await db.outboundQueue.bulkAdd(
          Array.from({ length: 4 }, (_, idx) => ({
            id: `hist-${idx}`,
            adapterId: "adp_hist",
            conversationKey: `c_${idx}`,
            request: makeRequest(`hist_${idx}`),
            status: (idx % 2 === 0 ? "sent" : "deadlettered") as "sent" | "deadlettered",
            attempts: 1,
            createdAt: baseAt + idx,
            nextAttemptAt: baseAt + idx,
            idempotencyKey: `hist_${idx}`,
            source: "ai-run" as const,
          }))
        )

        const fresh = await enqueue({
          adapterId: "adp_live",
          conversationKey: "c_live",
          request: makeRequest("k_live"),
        })

        const stored = await db.outboundQueue.get(fresh.id)
        expect(stored?.status).toBe("pending")
        const capped = await db.connectorAudit.where("kind").equals("outbound.queue_capped").count()
        expect(capped).toBe(0)
      } finally {
        restoreSoftCap()
      }
    }, 30_000)
  })

  // ── P0 — terminal-row retention sweep ────────────────────────────────
  describe("sweepTerminalOutboundRows", () => {
    const seedRow = (
      id: string,
      status: "pending" | "failed" | "sending" | "sent" | "deadlettered",
      createdAt: number
    ) =>
      getDb().outboundQueue.add({
        id,
        adapterId: "adp_sweep",
        conversationKey: `c_${id}`,
        request: makeRequest(`k_${id}`),
        status,
        attempts: 0,
        createdAt,
        nextAttemptAt: createdAt,
        idempotencyKey: `k_${id}`,
        source: "ai-run",
      })

    it("deletes only terminal rows older than the retention window", async () => {
      const now = Date.now()
      const old = now - OUTBOUND_TERMINAL_RETENTION_MS - 1_000
      const young = now - 60_000
      await seedRow("old-sent", "sent", old)
      await seedRow("old-dead", "deadlettered", old)
      await seedRow("old-pending", "pending", old) // active — must survive
      await seedRow("old-failed", "failed", old) // active — must survive
      await seedRow("young-sent", "sent", young) // inside retention — survives

      const deleted = await sweepTerminalOutboundRows({ now })
      expect(deleted).toBe(2)

      const remaining = (await getDb().outboundQueue.toArray()).map((r) => r.id).sort()
      expect(remaining).toEqual(["old-failed", "old-pending", "young-sent"])
    })

    it("caps one run at batchLimit and reports the deleted count", async () => {
      const now = Date.now()
      const old = now - OUTBOUND_TERMINAL_RETENTION_MS - 1_000
      for (let i = 0; i < 5; i++) await seedRow(`b-${i}`, "sent", old + i)
      expect(await sweepTerminalOutboundRows({ now, batchLimit: 3 })).toBe(3)
      expect(await getDb().outboundQueue.count()).toBe(2)
      // The next run drains the remainder.
      expect(await sweepTerminalOutboundRows({ now, batchLimit: 3 })).toBe(2)
      expect(await getDb().outboundQueue.count()).toBe(0)
    })

    it("returns 0 on an empty / all-young table", async () => {
      expect(await sweepTerminalOutboundRows()).toBe(0)
    })
  })

  // ── P1 — stale `sending` claim recovery ──────────────────────────────
  describe("recoverStaleSendingJobs", () => {
    it("markSending stamps claimedAt for the recovery age signal", async () => {
      const row = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_claim",
        request: makeRequest(),
      })
      await markSending(row.id, 777)
      const stored = (await getDb().outboundQueue.get(row.id)) as
        ({ claimedAt?: number } & typeof row) | undefined
      expect(stored?.claimedAt).toBe(777)
    })

    it("flips a stale sending row back to failed, retryable now", async () => {
      const now = Date.now()
      await getDb().outboundQueue.add({
        id: "stale-1",
        adapterId: "adp_1",
        conversationKey: "conv_stale",
        request: makeRequest("k_stale"),
        status: "sending",
        attempts: 1,
        createdAt: now - 60 * 60_000,
        nextAttemptAt: now - 60 * 60_000,
        idempotencyKey: "k_stale",
        source: "ai-run",
        claimedAt: now - STALE_SENDING_GRACE_MS - 1_000,
      } as never)

      const recovered = await recoverStaleSendingJobs(now)
      expect(recovered).toHaveLength(1)
      expect(recovered[0].id).toBe("stale-1")

      const stored = await getDb().outboundQueue.get("stale-1")
      expect(stored?.status).toBe("failed")
      expect(stored?.lastErrorCode).toBe("stale_sending_recovered")
      expect(stored?.nextAttemptAt).toBe(now)
      // The recovered row is immediately actionable again.
      expect((await pickNextDue())?.id).toBe("stale-1")
    })

    it("leaves a fresh sending row (inside the grace window) untouched", async () => {
      const row = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_fresh",
        request: makeRequest(),
      })
      await markSending(row.id) // claimedAt = now
      const recovered = await recoverStaleSendingJobs(Date.now())
      expect(recovered).toHaveLength(0)
      expect((await getDb().outboundQueue.get(row.id))?.status).toBe("sending")
    })

    it("falls back to createdAt for legacy rows without a claim stamp", async () => {
      const now = Date.now()
      await getDb().outboundQueue.add({
        id: "legacy-1",
        adapterId: "adp_1",
        conversationKey: "conv_legacy",
        request: makeRequest("k_legacy"),
        status: "sending",
        attempts: 2,
        createdAt: now - STALE_SENDING_GRACE_MS - 1_000,
        nextAttemptAt: now - STALE_SENDING_GRACE_MS - 1_000,
        idempotencyKey: "k_legacy",
        source: "ai-run",
      })
      const recovered = await recoverStaleSendingJobs(now)
      expect(recovered.map((r) => r.id)).toEqual(["legacy-1"])
      expect((await getDb().outboundQueue.get("legacy-1"))?.status).toBe("failed")
    })
  })

  // ── P3 — post-claim rate-limit unclaim ───────────────────────────────
  describe("unclaimSending", () => {
    it("reverts a sending claim to failed and refunds the attempt", async () => {
      const row = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_unclaim",
        request: makeRequest(),
      })
      await markSending(row.id) // attempts 0 → 1
      const nextAt = Date.now() + 1_000
      await unclaimSending(row.id, "rate_limited", "Token bucket exhausted", nextAt)
      const stored = await getDb().outboundQueue.get(row.id)
      expect(stored?.status).toBe("failed")
      expect(stored?.attempts).toBe(0)
      expect(stored?.lastErrorCode).toBe("rate_limited")
      expect(stored?.nextAttemptAt).toBe(nextAt)
    })

    it("no-ops on rows that are not sending", async () => {
      const row = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_unclaim2",
        request: makeRequest(),
      })
      await unclaimSending(row.id, "rate_limited", "x", Date.now())
      const stored = await getDb().outboundQueue.get(row.id)
      expect(stored?.status).toBe("pending")
      expect(stored?.attempts).toBe(0)
    })
  })

  // ── P1 — persistent idempotency evidence ─────────────────────────────
  describe("findDeliveredByIdempotencyKey", () => {
    it("finds a delivered sibling with the same key, excluding the caller row", async () => {
      const delivered = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_ev",
        request: makeRequest("shared-key"),
      })
      await markSent(delivered.id, "pm_evidence")
      const retry = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_ev",
        request: makeRequest("shared-key"),
      })
      const hit = await findDeliveredByIdempotencyKey("shared-key", retry.id)
      expect(hit?.id).toBe(delivered.id)
      expect(hit?.platformMessageId).toBe("pm_evidence")
      // The caller row itself never matches.
      expect(await findDeliveredByIdempotencyKey("shared-key", delivered.id)).toBeUndefined()
    })

    it("ignores non-sent rows and sent rows without a platform id", async () => {
      const pending = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_ev2",
        request: makeRequest("key-2"),
      })
      expect(await findDeliveredByIdempotencyKey("key-2")).toBeUndefined()
      await getDb().outboundQueue.update(pending.id, { status: "sent" }) // no platformMessageId
      expect(await findDeliveredByIdempotencyKey("key-2")).toBeUndefined()
    })
  })

  // ── P2 — cross-pass FIFO blocker lookup ──────────────────────────────
  describe("findOlderActiveOutboundSibling", () => {
    it("returns the oldest active older sibling and skips terminal ones", async () => {
      const older = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_fifo",
        request: makeRequest("k_older"),
      })
      await new Promise((r) => setTimeout(r, 2))
      const newer = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_fifo",
        request: makeRequest("k_newer"),
      })

      // Older sibling deferred (failed) — it blocks the newer one.
      await markFailed(older.id, "network", "retry later", Date.now() + 60_000)
      expect((await findOlderActiveOutboundSibling(newer))?.id).toBe(older.id)

      // Dead-lettered older sibling unblocks the newer one.
      await markDeadlettered(older.id, "max_attempts", "gave up")
      expect(await findOlderActiveOutboundSibling(newer)).toBeUndefined()

      // Sent older sibling unblocks too, and a job never blocks itself.
      await getDb().outboundQueue.update(older.id, { status: "sent" })
      expect(await findOlderActiveOutboundSibling(newer)).toBeUndefined()
      expect(await findOlderActiveOutboundSibling(older)).toBeUndefined()
    })

    it("finds the next active orderSeq sibling after a terminal head", async () => {
      const [head, next, last] = await enqueueOutboundMany(
        ["head", "next", "last"].map((key) => ({
          adapterId: "adp_1",
          conversationKey: "conv_next_fifo",
          request: makeRequest(key),
          source: "ai-run" as const,
        })),
        { now: 5_000 }
      )
      await getDb().outboundQueue.update(head.id, { status: "sent" })
      await getDb().outboundQueue.update(next.id, { status: "deadlettered" })

      expect((await findNextActiveOutboundSibling(head))?.id).toBe(last.id)
    })

    it("does not cross conversation boundaries", async () => {
      const otherConv = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_other",
        request: makeRequest("k_other"),
      })
      await new Promise((r) => setTimeout(r, 2))
      const mine = await enqueue({
        adapterId: "adp_1",
        conversationKey: "conv_mine",
        request: makeRequest("k_mine"),
      })
      expect(otherConv.status).toBe("pending")
      expect(await findOlderActiveOutboundSibling(mine)).toBeUndefined()
    })
  })

  describe("workspace (project) scoping", () => {
    it("inherits the conversation override's projectId when present", async () => {
      await getDb().conversationOverrides.add({
        id: "cov_x",
        conversationKey: "telegram:adp_1:chat_1",
        sessionId: "s",
        projectId: "proj-A",
        createdAt: 1,
        updatedAt: 1,
      } as never)
      const job = await enqueue({
        adapterId: "adp_1",
        conversationKey: "telegram:adp_1:chat_1",
        request: makeRequest("idem-scope"),
      })
      expect(job.projectId).toBe("proj-A")
    })

    it("falls back to the active project when no override exists", async () => {
      await saveSettings({ activeProjectId: "proj-active" })
      const job = await enqueue({
        adapterId: "adp_1",
        conversationKey: "telegram:adp_1:nokey",
        request: makeRequest("idem-fallback"),
      })
      expect(job.projectId).toBe("proj-active")
    })
  })

  // F1 — truthful feedback across failover / load-balance reroute.
  describe("waitForOutboundTerminal — reroute following", () => {
    it("resolves immediately for an already-sent job", async () => {
      const job = await enqueue({
        adapterId: "adp_1",
        conversationKey: "c1",
        request: makeRequest(),
      })
      await markSent(job.id, "om_direct")
      const term = await waitForOutboundTerminal(job.id, 5_000)
      expect(term?.status).toBe("sent")
      expect(term?.platformMessageId).toBe("om_direct")
    }, 30_000)

    it("returns undefined for an unknown job id", async () => {
      expect(await waitForOutboundTerminal("oqj_nope", 200)).toBeUndefined()
    }, 30_000)

    it("markDeadlettered stamps the reroute pointer + mechanism", async () => {
      const job = await enqueue({
        adapterId: "adp_1",
        conversationKey: "c1",
        request: makeRequest(),
      })
      await markDeadlettered(job.id, "balanced", "Balanced to adp_2", {
        toJobId: "oqj_sibling",
        mechanism: "balanced",
      })
      const row = await getDb().outboundQueue.get(job.id)
      expect(row?.status).toBe("deadlettered")
      expect(row?.reroutedToJobId).toBe("oqj_sibling")
      expect(row?.reroutedMechanism).toBe("balanced")
    }, 30_000)

    it("follows a rerouted-deadlettered job to the sibling's real terminal status", async () => {
      const original = await enqueue({
        adapterId: "adp_1",
        conversationKey: "c1",
        request: makeRequest("orig"),
      })
      const sibling = await enqueue({
        adapterId: "adp_2",
        conversationKey: "c1",
        request: makeRequest("sib"),
      })
      // Sibling actually delivered; original was dead-lettered as a reroute.
      await markSent(sibling.id, "om_sibling")
      await markDeadlettered(original.id, "failover", "Failed over to adp_2", {
        toJobId: sibling.id,
        mechanism: "failover",
      })
      // A caller awaiting the ORIGINAL must see the sibling's real delivery,
      // not the reroute dead-letter (the F1 bug).
      const term = await waitForOutboundTerminal(original.id, 5_000)
      expect(term?.id).toBe(sibling.id)
      expect(term?.status).toBe("sent")
      expect(term?.platformMessageId).toBe("om_sibling")
    }, 30_000)

    it("returns a plain deadlettered job as-is when there is no reroute pointer", async () => {
      const job = await enqueue({
        adapterId: "adp_1",
        conversationKey: "c1",
        request: makeRequest(),
      })
      await markDeadlettered(job.id, "max_attempts", "gave up")
      const term = await waitForOutboundTerminal(job.id, 5_000)
      expect(term?.id).toBe(job.id)
      expect(term?.status).toBe("deadlettered")
      expect(term?.reroutedToJobId).toBeUndefined()
    }, 30_000)
  })
})
