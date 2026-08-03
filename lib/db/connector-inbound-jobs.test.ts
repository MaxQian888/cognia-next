import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  bindConnectorInboundJobExecutionRun,
  claimConnectorInboundJob,
  claimNextConnectorInboundJob,
  completeConnectorInboundJob,
  countPendingConnectorInboundJobs,
  continueConnectorInboundJobSafely,
  dismissConnectorInboundJobRecovery,
  enqueueConnectorInboundJob,
  ensureConnectorInboundJob,
  listRecoverableConnectorInboundJobs,
  listPendingConnectorInboundJobs,
  markConnectorInboundJobHistoryOnly,
  markConnectorInboundJobRecoveryRequired,
  stampConnectorInboundJobPrincipal,
  recoverStaleConnectorInboundJobs,
  retryConnectorInboundJobFromStart,
  updateConnectorInboundJobPayload,
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

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("connector inbound jobs", () => {
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

  it("reports whether insertion won and scopes platform ids by conversation", async () => {
    const firstEvent = event("42", 10)
    const otherConversation = {
      ...event("42", 20),
      conversationKey: "lark:lk-1:oc-2:omt-2",
    }

    const first = await ensureConnectorInboundJob(firstEvent, "queue", { now: 100 })
    const duplicate = await ensureConnectorInboundJob(firstEvent, "steer", { now: 200 })
    const other = await ensureConnectorInboundJob(otherConversation, "queue", { now: 300 })

    expect(first.inserted).toBe(true)
    expect(duplicate).toEqual({ job: first.job, inserted: false })
    expect(other.inserted).toBe(true)
    expect(other.job.id).not.toBe(first.job.id)
    expect(first.job.sourceMessageId).toBe("42")
  })

  it("converges when another delivery wins the unique insert race", async () => {
    const db = getDb()
    const actualAdd = db.connectorInboundJobs.add.bind(db.connectorInboundJobs)
    jest.spyOn(db.connectorInboundJobs, "add").mockImplementationOnce((row) =>
      actualAdd(row).then(() => {
        throw new Error("ConstraintError")
      })
    )

    const result = await ensureConnectorInboundJob(event("om-race", 10), "queue", { now: 100 })

    expect(result.inserted).toBe(false)
    expect(result.job.sourceMessageId).toBe("om-race")
    expect(await db.connectorInboundJobs.count()).toBe(1)
  })

  it("surfaces an insert failure when no competing durable row exists", async () => {
    jest
      .spyOn(getDb().connectorInboundJobs, "add")
      .mockRejectedValueOnce(new Error("storage unavailable"))

    await expect(
      ensureConnectorInboundJob(event("om-failed-insert", 10), "queue", { now: 100 })
    ).rejects.toThrow("storage unavailable")
  })

  it("updates the durable payload, claims a specific job, and exposes recoverable work", async () => {
    const initial = await enqueueConnectorInboundJob(event("om-update", 10), "queue", { now: 100 })
    const transformed = {
      ...event("om-update", 10),
      plainText: "transformed",
      segments: [{ type: "text" as const, text: "transformed" }],
    }
    await updateConnectorInboundJobPayload(initial.id, transformed, "steer", { now: 200 })

    expect(await listRecoverableConnectorInboundJobs()).toEqual([
      expect.objectContaining({ id: initial.id, status: "steering", dispatchMode: "steer" }),
    ])
    await expect(
      claimConnectorInboundJob(initial.id, { leaseOwner: "runner", leaseMs: 100, now: 300 })
    ).resolves.toEqual(expect.objectContaining({ status: "running", event: transformed }))
  })

  it("does not mutate or claim missing and terminal jobs", async () => {
    await expect(countPendingConnectorInboundJobs("missing-conversation")).resolves.toBe(0)
    await expect(
      claimConnectorInboundJob("missing-job", { leaseOwner: "runner", leaseMs: 100, now: 1 })
    ).resolves.toBeUndefined()
    await expect(
      claimNextConnectorInboundJob("missing-conversation", {
        leaseOwner: "runner",
        leaseMs: 100,
        now: 1,
      })
    ).resolves.toBeUndefined()
    await updateConnectorInboundJobPayload("missing-job", event("missing", 1), "steer")

    const terminal = await enqueueConnectorInboundJob(event("om-terminal", 10), "queue")
    await completeConnectorInboundJob(terminal.id)
    await updateConnectorInboundJobPayload(terminal.id, event("om-terminal", 20), "steer")

    await expect(
      claimConnectorInboundJob(terminal.id, { leaseOwner: "runner", leaseMs: 100, now: 1 })
    ).resolves.toBeUndefined()
    await expect(bindConnectorInboundJobExecutionRun(terminal.id, "run-late")).resolves.toBe(false)
    expect(await getDb().connectorInboundJobs.get(terminal.id)).toMatchObject({
      status: "completed",
      dispatchMode: "queue",
    })
  })

  it("records non-executing overflow and ambiguous execution recovery states", async () => {
    const overflow = await enqueueConnectorInboundJob(event("om-overflow", 10), "queue")
    await markConnectorInboundJobHistoryOnly(overflow.id, "pending_limit_exceeded", { now: 200 })
    expect(await getDb().connectorInboundJobs.get(overflow.id)).toEqual(
      expect.objectContaining({ status: "history_only", recoveryReason: "pending_limit_exceeded" })
    )

    const ambiguous = await enqueueConnectorInboundJob(event("om-ambiguous", 20), "steer")
    await markConnectorInboundJobRecoveryRequired(ambiguous.id, "route_handler_failed", {
      error: "tool may have run",
      now: 300,
    })
    expect(await getDb().connectorInboundJobs.get(ambiguous.id)).toEqual(
      expect.objectContaining({
        status: "recovery_required",
        recoveryReason: "route_handler_failed",
        lastError: "tool may have run",
      })
    )
  })

  it("requires an explicit recovery action and distinguishes safe continuation from full retry", async () => {
    const continuing = await enqueueConnectorInboundJob(event("om-continue", 10), "queue")
    await markConnectorInboundJobRecoveryRequired(continuing.id, "ambiguous")
    await expect(continueConnectorInboundJobSafely(continuing.id, { now: 400 })).resolves.toBe(true)
    expect(await getDb().connectorInboundJobs.get(continuing.id)).toEqual(
      expect.objectContaining({
        status: "steering",
        dispatchMode: "steer",
        recoveryReason: "operator_continue_at_safe_boundary",
        event: expect.objectContaining({
          channelData: expect.objectContaining({
            dispatchIntent: "steer-replay",
            recoveryIntent: "continue_safely",
          }),
        }),
      })
    )

    const retrying = await enqueueConnectorInboundJob(event("om-retry", 20), "steer")
    await markConnectorInboundJobRecoveryRequired(retrying.id, "ambiguous")
    await expect(
      retryConnectorInboundJobFromStart(retrying.id, { confirmed: true, now: 500 })
    ).resolves.toBe(true)
    expect(await getDb().connectorInboundJobs.get(retrying.id)).toEqual(
      expect.objectContaining({
        status: "queued",
        dispatchMode: "queue",
        recoveryReason: "operator_retry_from_start",
      })
    )

    const dismissed = await enqueueConnectorInboundJob(event("om-dismiss", 30), "queue")
    await markConnectorInboundJobRecoveryRequired(dismissed.id, "ambiguous")
    await expect(dismissConnectorInboundJobRecovery(dismissed.id, { now: 600 })).resolves.toBe(true)
    expect(await getDb().connectorInboundJobs.get(dismissed.id)).toEqual(
      expect.objectContaining({ status: "dismissed", recoveryReason: "operator_dismissed" })
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

  it("reclaims every running job when a newly elected runtime owner starts", async () => {
    const job = await enqueueConnectorInboundJob(event("om-restart", 10), "queue", { now: 100 })
    await claimNextConnectorInboundJob(job.conversationKey, {
      leaseOwner: "dead-process",
      leaseMs: 20 * 60_000,
      now: 200,
    })

    await expect(
      recoverStaleConnectorInboundJobs({ now: 300, reclaimAllRunning: true })
    ).resolves.toBe(1)
    expect(await getDb().connectorInboundJobs.get(job.id)).toEqual(
      expect.objectContaining({
        status: "recovery_required",
        recoveryReason: "inbound_runtime_restarted",
      })
    )
  })

  it("binds an execution run before completion and preserves it when completing", async () => {
    const job = await enqueueConnectorInboundJob(event("om-run", 10), "queue", { now: 100 })
    await claimNextConnectorInboundJob(job.conversationKey, {
      leaseOwner: "active-runner",
      leaseMs: 1_000,
      now: 150,
    })
    await bindConnectorInboundJobExecutionRun(job.id, "execution:run-1", { now: 200 })
    await completeConnectorInboundJob(job.id, { now: 300 })

    expect(await getDb().connectorInboundJobs.get(job.id)).toEqual(
      expect.objectContaining({ status: "completed", executionRunId: "execution:run-1" })
    )
  })

  it("stamps the resolved account/principal onto the job row", async () => {
    const job = await enqueueConnectorInboundJob(event("om-principal", 10), "queue", { now: 100 })
    await stampConnectorInboundJobPrincipal(
      job.id,
      { accountId: "acct_a", principalId: "fp_1" },
      { now: 200 }
    )
    expect(await getDb().connectorInboundJobs.get(job.id)).toEqual(
      expect.objectContaining({ accountId: "acct_a", principalId: "fp_1", updatedAt: 200 })
    )
  })
})
