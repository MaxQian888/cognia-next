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
  recordConnectorInboundRecall,
  recordConnectorInboundEdit,
  findConnectorInboundMutation,
  listRecoverableConnectorInboundJobs,
  listPendingConnectorInboundJobs,
  markConnectorInboundJobHistoryOnly,
  markConnectorInboundJobRecoveryRequired,
  stampConnectorInboundJobPrincipal,
  recoverStaleConnectorInboundJobs,
  retryConnectorInboundJobFromStart,
  sweepTerminalConnectorInboundJobs,
  updateConnectorInboundJobPayload,
  acknowledgeConnectorInboundMutation,
  listConnectorInboundMutationJobs,
  INBOUND_HISTORY_RETENTION_MS,
  INBOUND_RECOVERY_RETENTION_MS,
} from "./connector-inbound-jobs"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ConnectorInboundJobRow } from "./connector-types"

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

it("does not acknowledge a newer mutation using an older window's token", async () => {
  const create = event("ack-source", 1)
  const job = await enqueueConnectorInboundJob(create, "queue")
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    messageId: "edit-1",
    replacesMessageId: create.messageId,
    timestamp: 2,
  })
  const first = (await getDb().connectorInboundJobs.get(job.id))!
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    messageId: "edit-2",
    replacesMessageId: create.messageId,
    timestamp: 3,
  })
  await acknowledgeConnectorInboundMutation(job.id, first.mutationRevision)
  const latest = (await getDb().connectorInboundJobs.get(job.id))!
  expect(latest.appliedMutationRevision).toBeUndefined()
  expect(await listConnectorInboundMutationJobs()).toEqual([latest])
  await acknowledgeConnectorInboundMutation(job.id, latest.mutationRevision)
  expect(await listConnectorInboundMutationJobs()).toEqual([])
})

it("retains an unapplied mutation with canonical history until its exact ACK", async () => {
  const create = event("pinned-source", 1)
  const job = await enqueueConnectorInboundJob(create, "queue")
  await completeConnectorInboundJob(job.id)
  await getDb().messages.put({
    id: "pinned-row",
    sessionId: "pinned-session",
    role: "user",
    createdAt: 1,
    parts: [{ type: "text", text: "original" }],
    platformMessageId: create.messageId,
    metadata: {
      platformMessage: {
        messageId: create.messageId,
        platform: create.platform,
        adapterId: create.adapterId,
        conversationKey: create.conversationKey,
        sender: create.sender,
      },
    },
  })
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    messageId: "pinned-edit",
    replacesMessageId: create.messageId,
    timestamp: 2,
  })
  const current = (await getDb().connectorInboundJobs.get(job.id))!
  const now = current.updatedAt + INBOUND_HISTORY_RETENTION_MS + 1
  expect(await sweepTerminalConnectorInboundJobs({ now })).toBe(0)
  await acknowledgeConnectorInboundMutation(job.id, current.mutationRevision)
  expect(await sweepTerminalConnectorInboundJobs({ now })).toBe(1)
})

it.each(["edit", "delete"] as const)(
  "rolls back a new %s placeholder if its mutation write fails",
  async (kind) => {
    const mutation = { ...event(`atomic-${kind}`, 2), kind, replacesMessageId: "original" }
    const db = getDb()
    const write = jest
      .spyOn(db.connectorInboundJobs, "update")
      .mockRejectedValueOnce(new Error("injected mutation write failure"))
    try {
      await expect(
        kind === "edit"
          ? recordConnectorInboundEdit(mutation)
          : recordConnectorInboundRecall(mutation, 2)
      ).rejects.toThrow("injected mutation write failure")
    } finally {
      write.mockRestore()
    }
    db.close()
    await db.open()
    expect(await db.connectorInboundJobs.count()).toBe(0)
  }
)

it("removes a Matrix replacement redacted before its original or before the replacement", async () => {
  const create = {
    ...event("!r:s|$original", 1),
    platform: "matrix" as const,
    conversationKey: "matrix:lk-1:!r:s",
  }
  const edit = {
    ...create,
    kind: "edit" as const,
    messageId: "!r:s|$edit",
    replacesMessageId: create.messageId,
    timestamp: 2,
    raw: { event_id: "$edit" },
    plainText: "withdrawn",
  }
  const recall = {
    ...create,
    kind: "delete" as const,
    messageId: "!r:s|$redaction",
    replacesMessageId: edit.messageId,
    timestamp: 3,
  }
  await recordConnectorInboundRecall(recall, 3)
  await recordConnectorInboundEdit(edit)
  await ensureConnectorInboundJob(create, "queue")
  expect((await findConnectorInboundMutation(create))?.pendingEdit).toBeUndefined()
  expect((await findConnectorInboundMutation(create))?.recalledAt).toBeUndefined()
})

it("retains a threaded recall fence as long as its queued source survives", async () => {
  const create = {
    ...event("recall-retained-source", 100),
    platform: "matrix" as const,
    conversationKey: "matrix:lk-1:!room:srv:$thread",
  }
  const { job } = await ensureConnectorInboundJob(create, "queue", { now: 100 })
  await recordConnectorInboundRecall(
    {
      ...create,
      kind: "delete",
      replacesMessageId: create.messageId,
      conversationKey: "matrix:lk-1:!room:srv",
    },
    200
  )
  await sweepTerminalConnectorInboundJobs({ now: 200 + INBOUND_HISTORY_RETENTION_MS + 1 })
  expect((await getDb().connectorInboundJobs.get(job.id))?.status).toBe("queued")
  expect((await findConnectorInboundMutation(create))?.recalledAt).toBe(200)
})

it("rechecks a terminal retention snapshot before deleting a promoted late create", async () => {
  const create = event("sweep-promoted", 1)
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    replacesMessageId: create.messageId,
    timestamp: 2,
  })
  const db = getDb()
  const placeholder = (await db.connectorInboundJobs.toArray())[0]
  await db.connectorInboundJobs.update(placeholder.id, { updatedAt: 0 })
  const collection = db.connectorInboundJobs.toCollection()
  const prototype = Object.getPrototypeOf(collection) as { toArray: typeof collection.toArray }
  const original = prototype.toArray
  const read = jest.spyOn(prototype, "toArray").mockImplementation(async function (
    this: typeof collection
  ) {
    const rows = (await Reflect.apply(original, this, [])) as ConnectorInboundJobRow[]
    if (rows.some((row) => row.id === placeholder.id)) {
      read.mockRestore()
      await ensureConnectorInboundJob(create, "queue")
    }
    return rows
  } as never)
  try {
    await expect(
      sweepTerminalConnectorInboundJobs({ now: INBOUND_HISTORY_RETENTION_MS + 1 })
    ).resolves.toBe(0)
    expect((await db.connectorInboundJobs.get(placeholder.id))?.status).toBe("queued")
  } finally {
    read.mockRestore()
  }
})

it("keeps equal-clock Matrix edit ordering after recovery payload compaction", async () => {
  const create = { ...event("!room:srv|$original", 1), platform: "matrix" as const }
  const accepted = await ensureConnectorInboundJob(create, "queue")
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    messageId: "!room:srv|$z",
    replacesMessageId: create.messageId,
    timestamp: 20,
    raw: { event_id: "$z" },
    plainText: "newest",
  })
  await markConnectorInboundJobRecoveryRequired(accepted.job.id, "recovery")
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    messageId: "!room:srv|$a",
    replacesMessageId: create.messageId,
    timestamp: 20,
    raw: { event_id: "$a" },
    plainText: "stale",
  })
  expect((await findConnectorInboundMutation(create))?.pendingEdit?.plainText).toBe("newest")
})

it("keeps early Matrix edit candidates separate until the original author is known", async () => {
  const create = {
    ...event("!room:srv|$original", 1),
    platform: "matrix" as const,
    conversationKey: "matrix:lk-1:!room:srv",
    sender: { ...event("", 1).sender, remoteUserId: "@alice:srv" },
  }
  const forged = {
    ...create,
    kind: "edit" as const,
    messageId: "!room:srv|$z",
    replacesMessageId: create.messageId,
    timestamp: 3,
    sender: { ...create.sender, remoteUserId: "@mallory:srv" },
    plainText: "forged",
  }
  const valid = {
    ...create,
    kind: "edit" as const,
    messageId: "!room:srv|$a",
    replacesMessageId: create.messageId,
    timestamp: 2,
    plainText: "valid",
  }
  await recordConnectorInboundEdit(forged)
  await recordConnectorInboundEdit(valid)
  expect((await findConnectorInboundMutation(create))?.pendingEdit?.plainText).toBe("valid")
  const accepted = await ensureConnectorInboundJob(create, "queue")
  expect(accepted.job.pendingEdit?.plainText).toBe("valid")
  await recordConnectorInboundEdit({ ...forged, timestamp: 4 })
  expect((await findConnectorInboundMutation(create))?.pendingEdit?.plainText).toBe("valid")
})

it("promotes an edit that arrived before the create exactly once", async () => {
  const create = event("edit-before-enqueue", 1)
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    replacesMessageId: create.messageId,
    timestamp: 2,
    plainText: "edited",
  })
  const accepted = await ensureConnectorInboundJob(create, "queue")
  expect(accepted.inserted).toBe(true)
  expect(accepted.job.status).toBe("queued")
  expect(accepted.job.pendingEdit?.plainText).toBe("edited")
  expect((await ensureConnectorInboundJob(create, "queue")).inserted).toBe(false)
})

it("never promotes an early edit placeholder once the message has been recalled", async () => {
  const create = event("edit-then-recall", 1)
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    replacesMessageId: create.messageId,
    timestamp: 2,
  })
  await recordConnectorInboundRecall(
    { ...create, kind: "delete", replacesMessageId: create.messageId },
    3
  )
  expect((await ensureConnectorInboundJob(create, "queue")).inserted).toBe(false)
  expect((await findConnectorInboundMutation(create))?.recalledAt).toBe(3)
})

it("keeps only the newest queued edit and never replaces a recall with an edit", async () => {
  const create = event("pending-edit", 1)
  await ensureConnectorInboundJob(create, "queue")
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    replacesMessageId: create.messageId,
    timestamp: 3,
    plainText: "new",
  })
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    replacesMessageId: create.messageId,
    timestamp: 2,
    plainText: "old",
  })
  expect((await findConnectorInboundMutation(create))?.pendingEdit?.plainText).toBe("new")
  await recordConnectorInboundRecall(
    { ...create, kind: "delete", replacesMessageId: create.messageId },
    4
  )
  await recordConnectorInboundEdit({
    ...create,
    kind: "edit",
    replacesMessageId: create.messageId,
    timestamp: 5,
    plainText: "resurrect",
  })
  expect((await findConnectorInboundMutation(create))?.recalledAt).toBe(4)
})

it("fences a queued or delayed create after a threadless recall without crossing chat scope", async () => {
  const create = event("om-recalled", 1)
  await ensureConnectorInboundJob(create, "queue")
  await recordConnectorInboundRecall(
    {
      ...create,
      kind: "delete",
      replacesMessageId: create.messageId,
      conversationKey: "lark:lk-1:oc-1",
    },
    2
  )
  expect((await findConnectorInboundMutation(create))?.recalledAt).toBe(2)
  expect(
    (await findConnectorInboundMutation({ ...create, conversationKey: "lark:lk-1:oc-10" }))
      ?.recalledAt
  ).toBeUndefined()
  expect(
    (await findConnectorInboundMutation({ ...create, adapterId: "other" }))?.recalledAt
  ).toBeUndefined()
})

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
    const continuing = await enqueueConnectorInboundJob(
      {
        ...event("om-continue", 10),
        channelData: { activeRunDispatchMode: "steer" },
      },
      "queue"
    )
    await markConnectorInboundJobRecoveryRequired(continuing.id, "ambiguous")
    await expect(
      continueConnectorInboundJobSafely(continuing.id, {
        now: 400,
        recoveryAnchor: { version: 1, attemptId: "attempt-2" },
      })
    ).resolves.toBe(true)
    expect(await getDb().connectorInboundJobs.get(continuing.id)).toEqual(
      expect.objectContaining({
        status: "steering",
        dispatchMode: "steer",
        recoveryReason: "operator_continue_at_safe_boundary",
        event: expect.objectContaining({
          channelData: expect.objectContaining({
            dispatchIntent: "steer-replay",
            recoveryIntent: "continue_safely",
            recoveryAnchor: { version: 1, attemptId: "attempt-2" },
          }),
          plainText: expect.not.stringContaining("om-continue"),
        }),
      })
    )
    expect(
      (await getDb().connectorInboundJobs.get(continuing.id))?.event.channelData
        ?.activeRunDispatchMode
    ).toBeUndefined()

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

  it("does not overwrite a recovery-required handler outcome with completion", async () => {
    const job = await enqueueConnectorInboundJob(event("om-drift", 10), "queue", { now: 100 })
    await claimNextConnectorInboundJob(job.conversationKey, {
      leaseOwner: "active-runner",
      leaseMs: 1_000,
      now: 150,
    })
    await markConnectorInboundJobRecoveryRequired(job.id, "recovery_execution_drift", {
      now: 200,
    })

    await completeConnectorInboundJob(job.id, { now: 300 })

    expect(await getDb().connectorInboundJobs.get(job.id)).toEqual(
      expect.objectContaining({
        status: "recovery_required",
        recoveryReason: "recovery_execution_drift",
      })
    )
  })

  it("compacts terminal payloads while retaining recovery identity", async () => {
    const richEvent: NormalizedInboundEvent = {
      ...event("om-compact", 10),
      raw: { token: "must-not-survive" },
      channelData: { dispatchIntent: "queue", recoveryCursor: "cursor-1" },
      segments: [
        {
          type: "image",
          url: "https://example.test/image.png",
          dataBase64: "aW5saW5lLWJ5dGVz",
          mimeType: "image/png",
          ocrText: "receipt",
        },
      ],
    }
    const completed = await enqueueConnectorInboundJob(richEvent, "queue", { now: 100 })
    await completeConnectorInboundJob(completed.id, { now: 200 })

    const storedCompleted = await getDb().connectorInboundJobs.get(completed.id)
    expect(storedCompleted?.event).toEqual(
      expect.objectContaining({
        adapterId: "lk-1",
        messageId: "om-compact",
        conversationKey: richEvent.conversationKey,
      })
    )
    expect("raw" in (storedCompleted?.event ?? {})).toBe(false)
    expect(storedCompleted?.event.channelData).toBeUndefined()
    expect(storedCompleted?.event.segments[0]).not.toHaveProperty("dataBase64")

    const recovery = await enqueueConnectorInboundJob(
      { ...richEvent, messageId: "om-recovery" },
      "queue",
      { now: 300 }
    )
    await markConnectorInboundJobRecoveryRequired(recovery.id, "ambiguous", { now: 400 })
    const storedRecovery = await getDb().connectorInboundJobs.get(recovery.id)
    expect("raw" in (storedRecovery?.event ?? {})).toBe(false)
    expect(storedRecovery?.event.channelData).toEqual(richEvent.channelData)
  })

  it("applies bounded 7/30-day terminal retention without deleting active leases", async () => {
    const now = 100 * 24 * 60 * 60 * 1_000
    const rows = await Promise.all(
      ["history-old", "history-edge", "recovery-old", "recovery-edge", "running"].map((id, index) =>
        enqueueConnectorInboundJob(event(id, index + 1), "queue", { now: index })
      )
    )
    await getDb().connectorInboundJobs.update(rows[0].id, {
      status: "completed",
      updatedAt: now - INBOUND_HISTORY_RETENTION_MS - 1,
    })
    await getDb().connectorInboundJobs.update(rows[1].id, {
      status: "history_only",
      updatedAt: now - INBOUND_HISTORY_RETENTION_MS + 1,
    })
    await getDb().connectorInboundJobs.update(rows[2].id, {
      status: "recovery_required",
      updatedAt: now - INBOUND_RECOVERY_RETENTION_MS - 1,
    })
    await getDb().connectorInboundJobs.update(rows[3].id, {
      status: "failed",
      updatedAt: now - INBOUND_RECOVERY_RETENTION_MS + 1,
    })
    await getDb().connectorInboundJobs.update(rows[4].id, {
      status: "running",
      updatedAt: 1,
      leaseExpiresAt: now + 1_000,
    })

    await expect(sweepTerminalConnectorInboundJobs({ now, batchLimit: 1 })).resolves.toBe(1)
    await expect(sweepTerminalConnectorInboundJobs({ now, batchLimit: 10 })).resolves.toBe(1)
    expect(await getDb().connectorInboundJobs.bulkGet(rows.map((row) => row.id))).toEqual([
      undefined,
      expect.objectContaining({ status: "history_only" }),
      undefined,
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "running" }),
    ])
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
