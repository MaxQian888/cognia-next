import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

let platformValue: "tauri" | "headless" | "web" = "tauri"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => platformValue,
  isTauri: () => platformValue === "tauri",
}))

// The default deps are lazily imported; stub the modules so the executor can
// still build without the connector runtime, then always inject deps in tests.
jest.mock("@/lib/db/connector-conversation-state", () => ({
  getConnectorConversationState: jest.fn(),
}))
jest.mock("@/lib/db/conversation-overrides", () => ({ readForResolution: jest.fn() }))
jest.mock("@/lib/connectors/delivery-gateway", () => ({ enqueueGoverned: jest.fn() }))
jest.mock("@/lib/connectors/audit", () => ({ appendAudit: jest.fn() }))
jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { scheduler: stub }, createLogger: () => stub }
})

import { createImPushExecutor, executeImPushTask } from "./im-push-executor"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { appendAudit } from "@/lib/connectors/audit"

const deliveryTarget = {
  address: { adapterId: "lark-1", platform: "lark" },
  conversationRef: { chatId: "oc_1" },
  refreshedAt: 1,
}

function makeTask(payload: unknown): ScheduledTask {
  return {
    id: "task-im",
    name: "Morning digest",
    type: "im-push",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    payload: payload as ScheduledTask["payload"],
    config: { maxRetries: 0, retryDelay: 1000, timeout: 30_000, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeExecution(overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: "exec-im",
    taskId: "task-im",
    taskName: "Morning digest",
    taskType: "im-push",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date(),
    logs: [],
    ...overrides,
  }
}

function makeDeps(overrides: Partial<Parameters<typeof createImPushExecutor>[0]> = {}) {
  return {
    getConversationState: jest.fn(async () => ({ deliveryTarget })),
    readOverride: jest.fn(async () => ({ proactivePush: true })),
    enqueue: jest.fn(async () => ({ id: "job-1" })),
    audit: jest.fn(async () => ({})),
    isPiiSafe: jest.fn(() => true),
    ...overrides,
  } as unknown as Required<NonNullable<Parameters<typeof createImPushExecutor>[0]>>
}

beforeEach(() => {
  platformValue = "tauri"
})

describe("executeImPushTask", () => {
  it("is refused on hosts without the connector runtime", async () => {
    platformValue = "web"
    const deps = makeDeps()
    const r = await createImPushExecutor(deps)(
      makeTask({ conversationKey: "c1", text: "hi" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.terminalReason).toBe("unsupported-on-host")
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it("validates the payload shape", async () => {
    const run = createImPushExecutor(makeDeps())
    for (const payload of [
      undefined,
      [],
      {},
      { conversationKey: " " },
      { conversationKey: "c1" },
      { conversationKey: "c1", text: "  " },
    ]) {
      const r = await run(makeTask(payload), makeExecution(), new AbortController().signal)
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/conversationKey|text/)
    }
    const bad = await run(
      makeTask({ conversationKey: "c1", segments: [{ nope: true }] }),
      makeExecution(),
      new AbortController().signal
    )
    expect(bad.error).toMatch(/MessageSegment/)
  })

  it("returns early when aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await createImPushExecutor(makeDeps())(
      makeTask({ conversationKey: "c1", text: "hi" }),
      makeExecution(),
      controller.signal
    )
    expect(r.error).toMatch(/aborted/)
  })

  it("wraps text into one segment, resolves adapterId from the delivery target and enqueues idempotently", async () => {
    const deps = makeDeps()
    const r = await createImPushExecutor(deps)(
      makeTask({ conversationKey: " c1 ", text: "Good morning" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(deps.enqueue).toHaveBeenCalledWith({
      adapterId: "lark-1",
      conversationKey: "c1",
      request: {
        conversationRef: { chatId: "oc_1" },
        deliveryTarget,
        segments: [{ type: "text", text: "Good morning" }],
        metadata: { idempotencyKey: "task-im:exec-im" },
      },
      source: "manual",
    })
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "notify.im_pushed" }))
    expect(r.output).toMatchObject({ jobId: "job-1", adapterId: "lark-1", segments: 1 })
  })

  it("prefers explicit segments, a custom idempotency key and per-execution input", async () => {
    const deps = makeDeps()
    const segments = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]
    await createImPushExecutor(deps)(
      makeTask({ conversationKey: "c1", text: "ignored" }),
      makeExecution({ input: { conversationKey: "c2", segments, idempotencyKey: "k9" } }),
      new AbortController().signal
    )
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "c2",
        request: expect.objectContaining({ segments, metadata: { idempotencyKey: "k9" } }),
      })
    )
  })

  it("fails when no delivery target is persisted", async () => {
    const deps = makeDeps({ getConversationState: jest.fn(async () => undefined) })
    const r = await createImPushExecutor(deps)(
      makeTask({ conversationKey: "c1", text: "hi" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/No persisted delivery target/)
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it("enforces the proactive-push opt-in fail-closed and audits the skip", async () => {
    const deps = makeDeps({ readOverride: jest.fn(async () => undefined) })
    const r = await createImPushExecutor(deps)(
      makeTask({ conversationKey: "c1", text: "hi" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Proactive push is switched off/)
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "notify.im_skipped", reason: "opt_in_off" })
    )
    expect(deps.enqueue).not.toHaveBeenCalled()

    const throwing = makeDeps({
      readOverride: jest.fn(async () => {
        throw new Error("db")
      }),
    })
    const r2 = await createImPushExecutor(throwing)(
      makeTask({ conversationKey: "c1", text: "hi" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r2.output).toMatchObject({ reason: "opt_in_off" })
  })

  it("blocks and audits when the PII gate trips (rich segments are inspected too)", async () => {
    const isPiiSafe = jest.fn((_text: string) => false)
    const deps = makeDeps({ isPiiSafe })
    const r = await createImPushExecutor(deps)(
      makeTask({
        conversationKey: "c1",
        segments: [
          { type: "text", text: "ssn" },
          { type: "image", url: "x" },
        ],
      }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/PII gate/)
    expect(isPiiSafe).toHaveBeenCalledWith(expect.stringContaining("ssn"))
    expect(isPiiSafe.mock.calls[0][0]).toContain('"type":"image"')
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "notify.im_pii_blocked", reason: "pii_blocked" })
    )
  })

  it("surfaces enqueue failures", async () => {
    const deps = makeDeps({
      enqueue: jest.fn(async () => {
        throw new Error("queue closed")
      }),
    })
    const r = await createImPushExecutor(deps)(
      makeTask({ conversationKey: "c1", text: "hi" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r).toMatchObject({
      success: false,
      error: "queue closed",
      output: { adapterId: "lark-1" },
    })
  })

  it("default executor uses the real modules", async () => {
    jest.mocked(getConnectorConversationState).mockResolvedValue({ deliveryTarget } as never)
    jest.mocked(readForResolution).mockResolvedValue({ proactivePush: true } as never)
    jest.mocked(enqueueGoverned).mockResolvedValue({ id: "job-real" } as never)
    jest.mocked(appendAudit).mockResolvedValue({} as never)
    const r = await executeImPushTask(
      makeTask({ conversationKey: "c1", text: "hello there" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(jest.mocked(enqueueGoverned)).toHaveBeenCalled()
  })
})
