jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/lib/workflow/runtime/tauri-bridge", () => ({
  createNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(null),
  decideNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(undefined),
  getNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(null),
  listNativePendingWorkflowWaitpoints: jest.fn().mockResolvedValue(null),
  persistNativeWorkflowWaitEvent: jest.fn().mockResolvedValue(undefined),
  pruneNativeWorkflowWaitEvents: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("./action-review-receipts", () => ({
  ACTION_REVIEW_RETENTION_DAYS: 30,
  recordActionReviewReceipt: jest.fn().mockResolvedValue(undefined),
}))

import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  cancelWorkflowWaitpoint,
  createWorkflowWaitEvent,
  createWorkflowWaitpoint,
  decideWorkflowWaitpoint,
  emitWorkflowWaitEvent,
  getWorkflowWaitpoint,
  listPendingWorkflowWaitpoints,
  pruneExpiredWorkflowWaitEvents,
  subscribeWorkflowWaitpointChanges,
  WORKFLOW_WAIT_EVENT_TTL_MS,
} from "./workflow-waitpoints"
import type { WorkflowWaitpoint } from "@/types/workflow/waitpoint"
import {
  createNativeWorkflowWaitpoint,
  decideNativeWorkflowWaitpoint,
  getNativeWorkflowWaitpoint,
  listNativePendingWorkflowWaitpoints,
  persistNativeWorkflowWaitEvent,
  pruneNativeWorkflowWaitEvents,
} from "@/lib/workflow/runtime/tauri-bridge"
import { recordActionReviewReceipt } from "./action-review-receipts"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowWaitpoints.clear()
  await getDb().workflowWaitEvents.clear()
  jest.mocked(createNativeWorkflowWaitpoint).mockReset().mockResolvedValue(null)
  jest.mocked(decideNativeWorkflowWaitpoint).mockReset().mockResolvedValue(null)
  jest.mocked(getNativeWorkflowWaitpoint).mockReset().mockResolvedValue(null)
  jest.mocked(listNativePendingWorkflowWaitpoints).mockReset().mockResolvedValue(null)
  jest.mocked(persistNativeWorkflowWaitEvent).mockReset().mockResolvedValue(undefined)
  jest.mocked(pruneNativeWorkflowWaitEvents).mockReset().mockResolvedValue(null)
  jest.mocked(recordActionReviewReceipt).mockReset().mockResolvedValue(undefined)
})
afterAll(dbFixture.dispose)

function waitpoint(overrides: Partial<WorkflowWaitpoint> = {}): WorkflowWaitpoint {
  return {
    id: "wp_1",
    kind: "approval",
    status: "pending",
    runId: "run_1",
    workflowId: "wf_1",
    stepId: "step_1",
    key: "approval:run_1:step_1",
    createdAt: 1_000,
    notBefore: 500,
    expiresAt: 5_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe("workflow waitpoint persistence", () => {
  it("keeps the original absolute deadline when a checkpoint is registered again", async () => {
    await createWorkflowWaitpoint(waitpoint())
    await createWorkflowWaitpoint(waitpoint({ expiresAt: 99_000, title: "changed" }))

    await expect(listPendingWorkflowWaitpoints()).resolves.toEqual([
      expect.objectContaining({ id: "wp_1", expiresAt: 5_000 }),
    ])
  })

  it("allows exactly one concurrent terminal decision", async () => {
    await createWorkflowWaitpoint(waitpoint())
    const [approved, rejected] = await Promise.all([
      decideWorkflowWaitpoint("wp_1", {
        outcome: "approved",
        respondedBy: "device:a",
        resolvedAt: 2_000,
      }),
      decideWorkflowWaitpoint("wp_1", {
        outcome: "rejected",
        respondedBy: "device:b",
        resolvedAt: 2_001,
      }),
    ])

    expect([approved, rejected].filter((result) => result.ok)).toHaveLength(1)
    expect([approved, rejected].filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "already-decided" },
    ])
  })

  it("returns not-found and exposes the cancellation helper", async () => {
    await expect(
      decideWorkflowWaitpoint("missing", {
        outcome: "approved",
        respondedBy: "local",
        resolvedAt: 2_000,
      })
    ).resolves.toEqual({ ok: false, reason: "not-found" })

    await createWorkflowWaitpoint(waitpoint({ id: "wp_cancel" }))
    await expect(
      cancelWorkflowWaitpoint("wp_cancel", "run-cancelled", 2_500)
    ).resolves.toMatchObject({
      ok: true,
      waitpoint: {
        status: "cancelled",
        resolution: { outcome: "cancelled", respondedBy: "run-cancelled" },
      },
    })
  })

  it("records stable review receipts for every approval terminal state", async () => {
    const cases = [
      ["approved", "device:phone", "allow", "human", { kind: "device", id: "phone" }],
      ["rejected", "alice", "deny", "human", { kind: "local-user", label: "alice" }],
      ["timed_out", "timeout", "expired", "timeout", undefined],
      ["cancelled", "system", "interrupted", "system", undefined],
    ] as const

    for (const [outcome, respondedBy] of cases) {
      const id = `wp_${outcome}`
      await createWorkflowWaitpoint(waitpoint({ id }))
      await decideWorkflowWaitpoint(id, { outcome, respondedBy, resolvedAt: 3_000 })
    }

    const receipts = jest.mocked(recordActionReviewReceipt).mock.calls.map(([receipt]) => receipt)
    for (const [outcome, , receiptOutcome, authority, actor] of cases) {
      const receipt = receipts.find((candidate) => candidate.id === `wp_${outcome}`)
      expect(receipt?.decision).toMatchObject({ outcome: receiptOutcome, authority })
      if (actor) expect(receipt?.decision.actor).toEqual(actor)
      else expect(receipt?.decision.actor).toBeUndefined()
    }
  })

  it("persists an event before the subscriber and consumes it once", async () => {
    const event = createWorkflowWaitEvent({
      id: "event_1",
      key: "deploy",
      correlationId: "tenant_a",
      source: "test",
      data: { ok: true },
      emittedAt: 2_000,
    })
    await emitWorkflowWaitEvent(event)

    const first = await createWorkflowWaitpoint(
      waitpoint({
        id: "wp_event_1",
        kind: "event_wait",
        key: "deploy",
        correlationId: "tenant_a",
        notBefore: 1_000,
      })
    )
    const second = await createWorkflowWaitpoint(
      waitpoint({
        id: "wp_event_2",
        kind: "event_wait",
        key: "deploy",
        correlationId: "tenant_a",
        notBefore: 1_000,
      })
    )

    expect(first).toMatchObject({ status: "resolved", resolution: { outcome: "event" } })
    expect(second.status).toBe("pending")
    expect(await getDb().workflowWaitEvents.get("event_1")).toMatchObject({
      consumedByWaitpointId: "wp_event_1",
    })
  })

  it("does not match an event older than the run or with another correlation id", async () => {
    await emitWorkflowWaitEvent(
      createWorkflowWaitEvent({
        id: "old",
        key: "deploy",
        correlationId: "tenant_b",
        source: "test",
        emittedAt: 400,
      })
    )
    const stored = await createWorkflowWaitpoint(
      waitpoint({ kind: "event_wait", key: "deploy", correlationId: "tenant_a" })
    )
    expect(stored.status).toBe("pending")
  })

  it("resolves only the earliest matching pending waitpoint when an event arrives", async () => {
    await createWorkflowWaitpoint(
      waitpoint({ id: "wp_second", kind: "event_wait", key: "deploy", createdAt: 2_000 })
    )
    await createWorkflowWaitpoint(
      waitpoint({ id: "wp_first", kind: "event_wait", key: "deploy", createdAt: 1_000 })
    )
    const listener = jest.fn()
    const unsubscribe = subscribeWorkflowWaitpointChanges(listener)

    const stored = await emitWorkflowWaitEvent(
      createWorkflowWaitEvent({ id: "live", key: "deploy", source: "connector", emittedAt: 3_000 })
    )
    unsubscribe()

    expect(stored.consumedByWaitpointId).toBe("wp_first")
    await expect(getDb().workflowWaitpoints.get("wp_first")).resolves.toMatchObject({
      status: "resolved",
      resolution: { outcome: "event", respondedBy: "connector" },
    })
    await expect(getDb().workflowWaitpoints.get("wp_second")).resolves.toMatchObject({
      status: "pending",
    })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: "wp_first" }))
    expect(decideNativeWorkflowWaitpoint).toHaveBeenCalledWith(
      "wp_first",
      expect.objectContaining({ outcome: "event" })
    )
  })

  it("keeps duplicate event emission idempotent", async () => {
    const original = createWorkflowWaitEvent({
      id: "duplicate",
      key: "deploy",
      source: "first",
      emittedAt: 2_000,
    })
    await emitWorkflowWaitEvent(original)

    await expect(
      emitWorkflowWaitEvent({ ...original, source: "second", data: "changed" })
    ).resolves.toEqual(original)
    expect(persistNativeWorkflowWaitEvent).toHaveBeenCalledTimes(2)
  })

  it("prunes unmatched events after 24 hours", async () => {
    const emittedAt = 1_000
    await emitWorkflowWaitEvent(
      createWorkflowWaitEvent({ id: "expired", key: "x", source: "test", emittedAt })
    )
    await expect(
      pruneExpiredWorkflowWaitEvents(emittedAt + WORKFLOW_WAIT_EVENT_TTL_MS)
    ).resolves.toBe(1)
    await expect(getDb().workflowWaitEvents.get("expired")).resolves.toBeUndefined()
    expect(pruneNativeWorkflowWaitEvents).toHaveBeenCalled()
  })

  it("delegates empty event pruning and builds event defaults", async () => {
    await expect(pruneExpiredWorkflowWaitEvents(100)).resolves.toBe(0)
    expect(pruneNativeWorkflowWaitEvents).toHaveBeenCalledWith(100)

    const event = createWorkflowWaitEvent({ key: "wake", source: "test" })
    expect(event).toMatchObject({ key: "wake", source: "test" })
    expect(event.id).toMatch(/^wfe_/)
    expect(event.expiresAt - event.emittedAt).toBe(WORKFLOW_WAIT_EVENT_TTL_MS)
    expect(event).not.toHaveProperty("correlationId")
    expect(event).not.toHaveProperty("data")
  })

  it("mirrors native rows into Dexie for create, get, and filtered list", async () => {
    const nativeCreated = waitpoint({ id: "native_created", title: "native" })
    jest.mocked(createNativeWorkflowWaitpoint).mockResolvedValueOnce(nativeCreated)
    await expect(createWorkflowWaitpoint(waitpoint({ id: "native_created" }))).resolves.toEqual(
      nativeCreated
    )
    await expect(getDb().workflowWaitpoints.get("native_created")).resolves.toEqual(nativeCreated)

    const nativeTerminal = waitpoint({
      id: "native_terminal",
      status: "rejected",
      resolution: { outcome: "rejected", respondedBy: "device:tablet", resolvedAt: 4_000 },
    })
    jest.mocked(getNativeWorkflowWaitpoint).mockResolvedValueOnce(nativeTerminal)
    await expect(getWorkflowWaitpoint("native_terminal")).resolves.toEqual(nativeTerminal)

    const nativeEvent = waitpoint({
      id: "native_event",
      kind: "event_wait",
      key: "deploy",
      createdAt: 100,
    })
    const nativeApproval = waitpoint({ id: "native_approval", createdAt: 50 })
    jest
      .mocked(listNativePendingWorkflowWaitpoints)
      .mockResolvedValueOnce([nativeApproval, nativeEvent])
    await expect(listPendingWorkflowWaitpoints("event_wait")).resolves.toEqual([nativeEvent])
    await expect(getDb().workflowWaitpoints.get("native_approval")).resolves.toEqual(nativeApproval)
  })

  it("honors native compare-and-set winners without a second local decision", async () => {
    await createWorkflowWaitpoint(waitpoint({ id: "native_race" }))
    const nativePending = waitpoint({ id: "native_race" })
    const nativeWinner = waitpoint({
      id: "native_race",
      status: "resolved",
      resolution: { outcome: "approved", respondedBy: "device:winner", resolvedAt: 2_100 },
    })
    jest
      .mocked(getNativeWorkflowWaitpoint)
      .mockResolvedValueOnce(nativePending)
      .mockResolvedValueOnce(nativeWinner)
    jest.mocked(decideNativeWorkflowWaitpoint).mockResolvedValueOnce(false)

    await expect(
      decideWorkflowWaitpoint("native_race", {
        outcome: "rejected",
        respondedBy: "device:loser",
        resolvedAt: 2_200,
      })
    ).resolves.toEqual({ ok: false, reason: "already-decided" })
    await expect(getDb().workflowWaitpoints.get("native_race")).resolves.toEqual(nativeWinner)
  })

  it("returns already-decided when the native mirror is already terminal", async () => {
    const terminal = waitpoint({
      id: "native_done",
      status: "timed_out",
      resolution: { outcome: "timed_out", respondedBy: "timeout", resolvedAt: 5_000 },
    })
    jest.mocked(getNativeWorkflowWaitpoint).mockResolvedValueOnce(terminal)

    await expect(
      decideWorkflowWaitpoint("native_done", {
        outcome: "approved",
        respondedBy: "late-device",
        resolvedAt: 5_001,
      })
    ).resolves.toEqual({ ok: false, reason: "already-decided" })
    expect(decideNativeWorkflowWaitpoint).not.toHaveBeenCalled()
  })
})
