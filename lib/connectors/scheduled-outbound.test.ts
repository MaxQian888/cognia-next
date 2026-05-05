/**
 * Tests for lib/connectors/scheduled-outbound.ts — Task 108.
 *
 * Drives both event types via the executor registry and asserts that the
 * correct outbound jobs appear in Dexie.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { installScheduledOutboundHandlers } from "./scheduled-outbound"

// Capture the registered executors so we can invoke them directly.
const registeredExecutors = new Map<
  string,
  (
    task: unknown,
    execution: unknown
  ) => Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }>
>()

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  registerTaskExecutor: jest.fn(
    (type: string, fn: (task: unknown, execution: unknown) => Promise<{ success: boolean }>) => {
      registeredExecutors.set(type, fn)
    }
  ),
  getTaskScheduler: jest.fn(() => ({
    triggerEventTask: jest.fn().mockResolvedValue(undefined),
  })),
}))

jest.mock("@/lib/logger", () => {
  const stub = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { loggers: { scheduler: stub, app: stub }, createLogger: () => stub }
})

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTask(payload?: Record<string, unknown>) {
  return { id: "t1", payload }
}

function makeExecution(input?: Record<string, unknown>) {
  return { id: "e1", input }
}

async function callExecutor(type: string, task: unknown, execution: unknown) {
  const fn = registeredExecutors.get(type)
  if (!fn) throw new Error(`Executor not registered: ${type}`)
  return fn(task, execution)
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await __resetDbForTesting()
  registeredExecutors.clear()
})

describe("installScheduledOutboundHandlers", () => {
  it("registers both executor types", () => {
    installScheduledOutboundHandlers()
    expect(registeredExecutors.has("connection:outbound:send")).toBe(true)
    expect(registeredExecutors.has("connection:scheduled:digest")).toBe(true)
  })
})

describe("connection:outbound:send executor", () => {
  beforeEach(() => installScheduledOutboundHandlers())

  it("enqueues an outbound job from execution.input", async () => {
    const conversationKey = "tg:adp_tg:chat_1_" + Math.random()
    const idempotencyKey = "idem_001_" + Math.random()
    const payload = {
      adapterId: "adp_tg",
      conversationKey,
      segments: [{ type: "text", text: "hello scheduled" }],
      idempotencyKey,
    }

    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution(payload)
    )

    expect(result.success).toBe(true)
    expect(result.output?.jobId).toBeDefined()

    const jobs = await getDb()
      .outboundQueue.filter((j) => j.conversationKey === conversationKey)
      .toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("adp_tg")
    expect(jobs[0].idempotencyKey).toBe(idempotencyKey)
  })

  it("falls back to task.payload when execution.input is absent", async () => {
    const conversationKey = "tg:adp_tg:chat_2_" + Math.random()
    const payload = {
      adapterId: "adp_tg",
      conversationKey,
      segments: [{ type: "text", text: "fallback" }],
    }

    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(payload),
      makeExecution(undefined)
    )

    expect(result.success).toBe(true)
    const jobs = await getDb()
      .outboundQueue.filter((j) => j.conversationKey === conversationKey)
      .toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].conversationKey).toBe(conversationKey)
  })

  it("returns error for invalid payload", async () => {
    const before = await getDb().outboundQueue.count()
    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution({ wrong: "field" })
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid/)
    const after = await getDb().outboundQueue.count()
    expect(after).toBe(before)
  })

  it("writes an audit entry", async () => {
    const payload = {
      adapterId: "adp_tg_audit",
      conversationKey: "tg:adp_tg:chat_3_" + Math.random(),
      segments: [{ type: "text", text: "audit test" }],
    }
    await callExecutor("connection:outbound:send", makeTask(), makeExecution(payload))

    const audit = await getDb()
      .connectorAudit.filter((r) => r.adapterId === "adp_tg_audit")
      .toArray()
    expect(audit.some((r) => r.kind === "outbound.enqueued")).toBe(true)
  })
})

describe("connection:scheduled:digest executor", () => {
  beforeEach(() => installScheduledOutboundHandlers())

  it("enqueues a placeholder outbound job (Phase 1 stub)", async () => {
    const conversationKey = "discord:adp_discord:ch_99_" + Math.random()
    const payload = {
      adapterId: "adp_discord",
      conversationKey,
      characterId: "char_001",
      prompt: "What is the daily summary?",
    }

    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution(payload)
    )

    expect(result.success).toBe(true)
    expect(result.output?.stub).toBe(true)

    const jobs = await getDb()
      .outboundQueue.filter((j) => j.conversationKey === conversationKey)
      .toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("adp_discord")
    expect(jobs[0].request.segments[0]).toMatchObject({ type: "text" })
  })

  it("writes an audit entry for the digest", async () => {
    const adapterId = "adp_discord_audit_" + Math.random()
    const payload = {
      adapterId,
      conversationKey: "discord:adp_discord:ch_77_" + Math.random(),
      characterId: "char_001",
      prompt: "Digest prompt",
    }
    await callExecutor("connection:scheduled:digest", makeTask(), makeExecution(payload))

    const audit = await getDb()
      .connectorAudit.filter((r) => r.adapterId === adapterId)
      .toArray()
    expect(audit.some((r) => r.kind === "outbound.enqueued")).toBe(true)
  })

  it("returns error for invalid digest payload", async () => {
    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({ adapterId: "a" }) // missing conversationKey, characterId, prompt
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid/)
  })
})
