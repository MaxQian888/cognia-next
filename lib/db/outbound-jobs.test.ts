/**
 * Tests for lib/db/outbound-jobs.ts — outbound delivery queue CRUD.
 */

import "fake-indexeddb/auto"
import {
  enqueueOutbound,
  pickNextDue,
  listPendingForConversation,
  markSending,
  markSent,
  markFailed,
  markDeadlettered,
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

describe("outbound-jobs", () => {
  it("enqueueOutbound creates a pending row with correct defaults", async () => {
    const row = await enqueueOutbound({
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
    const row = await enqueueOutbound({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    const picked = await pickNextDue()
    expect(picked?.id).toBe(row.id)
  })

  it("pickNextDue does not return rows with nextAttemptAt in the future", async () => {
    await enqueueOutbound({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
      nextAttemptAt: Date.now() + 60_000,
    })
    expect(await pickNextDue()).toBeUndefined()
  })

  it("listPendingForConversation returns FIFO order for conversation A", async () => {
    // Interleave jobs for A and B
    const a1 = await enqueueOutbound({
      adapterId: "adp_1",
      conversationKey: "conv_A",
      request: makeRequest(),
    })
    await new Promise((r) => setTimeout(r, 1))
    const _b1 = await enqueueOutbound({
      adapterId: "adp_1",
      conversationKey: "conv_B",
      request: makeRequest(),
    })
    await new Promise((r) => setTimeout(r, 1))
    const a2 = await enqueueOutbound({
      adapterId: "adp_1",
      conversationKey: "conv_A",
      request: makeRequest(),
    })
    await new Promise((r) => setTimeout(r, 1))
    const _b2 = await enqueueOutbound({
      adapterId: "adp_1",
      conversationKey: "conv_B",
      request: makeRequest(),
    })
    await new Promise((r) => setTimeout(r, 1))
    const a3 = await enqueueOutbound({
      adapterId: "adp_1",
      conversationKey: "conv_A",
      request: makeRequest(),
    })

    const aJobs = await listPendingForConversation("conv_A")
    expect(aJobs).toHaveLength(3)
    expect(aJobs.map((j) => j.id)).toEqual([a1.id, a2.id, a3.id])
  })

  it("listPendingForConversation excludes non-pending rows", async () => {
    const row = await enqueueOutbound({
      adapterId: "adp_1",
      conversationKey: "conv_1",
      request: makeRequest(),
    })
    await markSending(row.id)
    const pending = await listPendingForConversation("conv_1")
    expect(pending).toHaveLength(0)
  })

  it("markSending transitions status to sending", async () => {
    const row = await enqueueOutbound({
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
    const row = await enqueueOutbound({
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
    const row = await enqueueOutbound({
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
    const row = await enqueueOutbound({
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

  it("FIFO: 3 conv_A and 2 conv_B interleaved, conv_A returns in createdAt order", async () => {
    const jobs: { key: string; id: string }[] = []
    for (let i = 0; i < 5; i++) {
      const key = i % 2 === 0 ? "conv_A" : "conv_B"
      const row = await enqueueOutbound({
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
})
