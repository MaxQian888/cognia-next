/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "./schema"
import {
  claimNextConnectorInboundJob,
  completeConnectorInboundJob,
  enqueueConnectorInboundJob,
  listPendingConnectorInboundJobs,
  recoverStaleConnectorInboundJobs,
} from "./connector-inbound-jobs"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

function event(messageId: string, timestamp: number): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId: "lk-1",
    selfId: "bot",
    messageId,
    conversationRef: { platform: "lark", adapterId: "lk-1", channelId: "oc-1" },
    conversationKey: "lark:lk-1:oc-1:omt-1",
    sender: { id: "u-1", platform: "lark", adapterId: "lk-1", remoteUserId: "ou-1" },
    channel: { id: "oc-1", kind: "thread" },
    segments: [{ type: "text", text: messageId }],
    plainText: messageId,
    mentions: { selfMentioned: false, users: [] },
    timestamp,
    raw: {},
  }
}

describe("connector inbound jobs", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("deduplicates, claims in FIFO order, and completes durably", async () => {
    const first = await enqueueConnectorInboundJob(event("om-1", 10), "queue", { now: 100 })
    const duplicate = await enqueueConnectorInboundJob(event("om-1", 10), "queue", { now: 200 })
    await enqueueConnectorInboundJob(event("om-2", 20), "steer", { now: 300 })

    expect(duplicate).toEqual(first)
    expect(await listPendingConnectorInboundJobs(first.conversationKey)).toHaveLength(2)

    const claimed = await claimNextConnectorInboundJob(first.conversationKey, {
      leaseOwner: "runner-1",
      leaseMs: 30_000,
      now: 1_000,
    })
    expect(claimed).toEqual(
      expect.objectContaining({
        id: first.id,
        status: "running",
        leaseOwner: "runner-1",
        leaseExpiresAt: 31_000,
      })
    )

    await completeConnectorInboundJob(first.id, { executionRunId: "run-1", now: 2_000 })
    expect(await getDb().connectorInboundJobs.get(first.id)).toEqual(
      expect.objectContaining({ status: "completed", executionRunId: "run-1" })
    )
  })

  it("marks an expired running lease as recovery-required instead of replaying it", async () => {
    const job = await enqueueConnectorInboundJob(event("om-crash", 10), "queue", { now: 100 })
    await claimNextConnectorInboundJob(job.conversationKey, {
      leaseOwner: "dead-runner",
      leaseMs: 100,
      now: 200,
    })

    await expect(recoverStaleConnectorInboundJobs({ now: 301 })).resolves.toBe(1)
    expect(await getDb().connectorInboundJobs.get(job.id)).toEqual(
      expect.objectContaining({
        status: "recovery_required",
        recoveryReason: "inbound_run_lease_expired",
      })
    )
  })
})
