import { TurnActivityDispatcher } from "./turn-activity-dispatcher"
import { resolveActivityI18n } from "./i18n"
import type { EnqueueInput } from "@/lib/db/outbound-jobs"
import type { OutboundJobRow } from "@/lib/db/connector-types"

const i18n = resolveActivityI18n("en")

interface MockState {
  enqueue: jest.Mock<Promise<OutboundJobRow>, [EnqueueInput]>
  getJob: jest.Mock<Promise<OutboundJobRow | undefined>, [string]>
  onAudit: jest.Mock<void, [string, Record<string, unknown>?]>
  sleep: jest.Mock<Promise<void>, [number]>
}

function makeJob(over: Partial<OutboundJobRow> = {}): OutboundJobRow {
  return {
    id: "job-1",
    adapterId: "tg",
    conversationKey: "telegram:tg:1",
    status: "pending",
    attempts: 0,
    createdAt: 0,
    nextAttemptAt: 0,
    request: { conversationRef: { platform: "telegram", adapterId: "tg" }, segments: [] },
    source: "ai-run",
    ...over,
  } as unknown as OutboundJobRow
}

function makeDispatcher(opts: {
  supportsEdit?: boolean
  canAppend?: boolean
  job?: Partial<OutboundJobRow>
  getJobResult?: OutboundJobRow | undefined
}): { d: TurnActivityDispatcher; m: MockState } {
  const job = makeJob(opts.job ?? {})
  const m: MockState = {
    enqueue: jest.fn(async (_input: EnqueueInput) => job),
    getJob: jest.fn(async (_id: string) => opts.getJobResult),
    onAudit: jest.fn((_kind: string, _fields?: Record<string, unknown>) => undefined),
    sleep: jest.fn(async (_ms: number) => undefined),
  }
  const d = new TurnActivityDispatcher({
    adapterId: "tg",
    conversationKey: "telegram:tg:1",
    conversationRef: { platform: "telegram", adapterId: "tg" },
    surfaceId: "activity:telegram:tg:1:1",
    i18n,
    enqueue: m.enqueue,
    supportsEdit: () => opts.supportsEdit ?? true,
    canAppend: () => opts.canAppend ?? true,
    getJob: m.getJob,
    onAudit: m.onAudit,
    sleep: m.sleep,
    turnStartedAt: 1000,
  })
  return { d, m }
}

const T = 5_000

/** Drain the microtask queue N times so async flushes/polls settle. */
async function tick(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("TurnActivityDispatcher mode", () => {
  it("uses append mode when the adapter has no edit() (default canAppend)", () => {
    const { d } = makeDispatcher({ supportsEdit: false })
    expect(d.currentMode).toBe("append")
  })

  it("uses suppress mode when the adapter has no edit() AND canAppend is false", () => {
    const { d } = makeDispatcher({ supportsEdit: false, canAppend: false })
    expect(d.currentMode).toBe("suppress")
  })

  it("uses cumulative mode when the adapter supports edit()", () => {
    const { d } = makeDispatcher({ supportsEdit: true })
    expect(d.currentMode).toBe("cumulative")
  })
})

describe("TurnActivityDispatcher suppress mode (canAppend=false)", () => {
  it("never dispatches on events", () => {
    const { d, m } = makeDispatcher({ supportsEdit: false, canAppend: false })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    expect(m.enqueue).not.toHaveBeenCalled()
    expect(m.onAudit).not.toHaveBeenCalled()
  })

  it("finalize is a no-op in suppress mode", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: false, canAppend: false })
    await d.finalize("failed", T)
    expect(m.enqueue).not.toHaveBeenCalled()
    expect(m.onAudit).not.toHaveBeenCalled()
  })
})

describe("TurnActivityDispatcher append mode (no-edit adapter)", () => {
  it("emits a compact line per boundary — no edit target, per-emit idempotency key", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: false })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    await tick(5)
    expect(m.enqueue).toHaveBeenCalledTimes(1)
    const input = m.enqueue.mock.calls[0][0]
    expect(input.request.editTargetMessageId).toBeUndefined()
    expect(input.request.metadata?.idempotencyKey).toContain(":append:")
    // A plain text line, not an a2ui card.
    expect(input.request.segments[0]).toMatchObject({ type: "text" })
    expect(m.onAudit).toHaveBeenCalledWith(
      "activity.card_appended",
      expect.objectContaining({ appendCount: 1 })
    )
  })

  it("caps intermediate append lines at APPEND_MAX_LINES", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: false })
    // Fire many tool boundaries spaced out so each passes the throttle.
    for (let i = 0; i < 12; i++) {
      d.onEvent({ type: "tool-call", toolName: `t${i}`, input: {} }, T + i * 6_000)
      await tick(4)
    }
    expect(m.enqueue.mock.calls.length).toBeLessThanOrEqual(8)
  })

  it("finalize emits one terminal line after appends", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: false })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    await tick(5)
    const before = m.enqueue.mock.calls.length
    await d.finalize("done", T + 5_000)
    await tick(5)
    expect(m.enqueue.mock.calls.length).toBe(before + 1)
    expect(m.onAudit).toHaveBeenCalledWith(
      "activity.card_finalized",
      expect.objectContaining({ status: "done", mode: "append" })
    )
  })

  it("done with no appended lines suppresses the terminal", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: false })
    await d.finalize("done", T + 100)
    expect(m.enqueue).not.toHaveBeenCalled()
  })

  it("failed with no appended lines still emits one terminal line", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: false })
    await d.finalize("failed", T + 100)
    await tick(5)
    expect(m.enqueue).toHaveBeenCalledTimes(1)
  })

  it("flips to suppress when the first append line is deferred past the threshold", async () => {
    const { d, m } = makeDispatcher({
      supportsEdit: false,
      job: makeJob({ nextAttemptAt: T + 120_000 }),
    })
    expect(d.currentMode).toBe("append")
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    await tick(5)
    expect(d.currentMode).toBe("suppress")
    d.onEvent({ type: "tool-call", toolName: "read", input: {} }, T + 6_000)
    await tick(5)
    expect(m.enqueue).toHaveBeenCalledTimes(1)
  })
})

describe("TurnActivityDispatcher cumulative first flush", () => {
  it("dispatches the entry card with the entry idempotency key on a tool boundary", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: true })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    // The flush is async (void); let it settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(m.enqueue).toHaveBeenCalledTimes(1)
    const input = m.enqueue.mock.calls[0][0]
    expect(input.request.metadata?.idempotencyKey).toBe("activity:activity:telegram:tg:1:1:entry")
    expect(input.request.editTargetMessageId).toBeUndefined()
    expect(m.onAudit).toHaveBeenCalledWith(
      "activity.card_dispatched",
      expect.objectContaining({ status: "running" })
    )
  })
})

describe("TurnActivityDispatcher throttle", () => {
  it("skips a non-boundary event within the throttle window", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: true })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    await Promise.resolve()
    await Promise.resolve()
    // text-delta is not a boundary and within 5s window → no second dispatch
    d.onEvent({ type: "text-delta", delta: "x" }, T + 1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(m.enqueue).toHaveBeenCalledTimes(1)
  })

  it("dispatches immediately on a second tool boundary", async () => {
    const { d, m } = makeDispatcher({
      supportsEdit: true,
      getJobResult: makeJob({ platformMessageId: "plat-1" }),
    })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    await tick(5)
    d.onEvent({ type: "tool-call", toolName: "read", input: {} }, T + 100)
    await tick(10)
    expect(m.enqueue).toHaveBeenCalledTimes(2)
    // second call is an edit frame with editTargetMessageId resolved from getJob
    const second = m.enqueue.mock.calls[1][0]
    expect(second.request.editTargetMessageId).toBe("plat-1")
    expect(second.request.metadata?.idempotencyKey).toContain(`${T + 100}`)
  })
})

describe("TurnActivityDispatcher edit-fallback", () => {
  it("falls back to a fresh send and audits edit_fallback when platformMessageId never resolves", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: true, getJobResult: undefined })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    await tick(5)
    d.onEvent({ type: "tool-call", toolName: "read", input: {} }, T + 100)
    // resolvePlatformMessageId polls 20× (getJob + sleep); with mocked instant
    // resolves each iteration is ~2 microtasks, so drain generously.
    await tick(80)
    expect(m.enqueue).toHaveBeenCalledTimes(2)
    expect(m.getJob).toHaveBeenCalled()
    expect(m.onAudit).toHaveBeenCalledWith(
      "activity.edit_fallback",
      expect.objectContaining({ reason: "platformMessageId_unresolved" })
    )
    const second = m.enqueue.mock.calls[1][0]
    expect(second.request.editTargetMessageId).toBeUndefined()
  })
})

describe("TurnActivityDispatcher finalize", () => {
  it("done with a card edits to terminal and audits card_finalized", async () => {
    const { d, m } = makeDispatcher({
      supportsEdit: true,
      getJobResult: makeJob({ platformMessageId: "plat-1" }),
    })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    await Promise.resolve()
    await Promise.resolve()
    await d.finalize("done", T + 5000)
    expect(m.onAudit).toHaveBeenCalledWith(
      "activity.card_finalized",
      expect.objectContaining({ status: "done" })
    )
  })

  it("done with no card sent suppresses the terminal (final reply is the signal)", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: true })
    // No events at all → no card ever sent.
    await d.finalize("done", T + 100)
    expect(m.enqueue).not.toHaveBeenCalled()
    expect(m.onAudit).not.toHaveBeenCalled()
  })

  it("failed with no card sent emits one fresh terminal card + audits card_finalized", async () => {
    const { d, m } = makeDispatcher({ supportsEdit: true })
    await d.finalize("failed", T + 100)
    expect(m.enqueue).toHaveBeenCalledTimes(1)
    expect(m.onAudit).toHaveBeenCalledWith(
      "activity.card_finalized",
      expect.objectContaining({ status: "failed" })
    )
  })
})

describe("TurnActivityDispatcher enqueue failure", () => {
  it("swallows an enqueue rejection (best-effort) and returns without throwing", async () => {
    const enqueue = jest.fn(async () => {
      throw new Error("dexie locked")
    })
    const d = new TurnActivityDispatcher({
      adapterId: "tg",
      conversationKey: "telegram:tg:1",
      conversationRef: { platform: "telegram", adapterId: "tg" },
      surfaceId: "activity:x:1",
      i18n,
      enqueue,
      supportsEdit: () => true,
      getJob: jest.fn(async () => undefined),
      onAudit: jest.fn(),
      sleep: jest.fn(async () => undefined),
      turnStartedAt: 1000,
    })
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    // Should not throw; the catch logs + returns null.
    await tick(5)
    expect(enqueue).toHaveBeenCalled()
  })
})

describe("TurnActivityDispatcher in-flight guard", () => {
  it("coalesces a burst of events into the entry + at most one follow-up", async () => {
    const { d, m } = makeDispatcher({
      supportsEdit: true,
      getJobResult: makeJob({ platformMessageId: "p" }),
    })
    // Fire three tool calls back-to-back before the first flush settles.
    d.onEvent({ type: "tool-call", toolName: "a", input: {} }, T)
    d.onEvent({ type: "tool-call", toolName: "b", input: {} }, T + 1)
    d.onEvent({ type: "tool-call", toolName: "c", input: {} }, T + 2)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    // Entry (1) + at most one coalesced follow-up (1) — never 3 concurrent.
    expect(m.enqueue.mock.calls.length).toBeLessThanOrEqual(2)
    expect(m.enqueue.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})

describe("TurnActivityDispatcher quiet-hours suppress", () => {
  it("flips to suppress when the first dispatch is deferred past the threshold", async () => {
    const { d, m } = makeDispatcher({
      supportsEdit: true,
      job: makeJob({ nextAttemptAt: T + 120_000 }),
    })
    expect(d.currentMode).toBe("cumulative")
    d.onEvent({ type: "tool-call", toolName: "bash", input: {} }, T)
    await Promise.resolve()
    await Promise.resolve()
    expect(d.currentMode).toBe("suppress")
    // Subsequent events do nothing.
    d.onEvent({ type: "tool-call", toolName: "read", input: {} }, T + 200)
    await Promise.resolve()
    await Promise.resolve()
    expect(m.enqueue).toHaveBeenCalledTimes(1)
  })
})
