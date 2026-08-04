const mockTrackEvent = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

import {
  appendEvent,
  appendEvents,
  createRunLogger,
  enqueueRunEvent,
  listRunEvents,
} from "./event-log"
import { listUsageForSession } from "@/lib/db/session-usage"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRunEvents.clear()
  mockTrackEvent.mockClear()
})
afterAll(dbFixture.dispose)

describe("event-log ts monotonicity", () => {
  // `listRunEvents` orders by the [runId+ts] compound index; for equal ts
  // IndexedDB falls back to the random nanoid primary key, which used to
  // scramble same-millisecond events (flaky orchestrator timeline ordering).
  it("appendEvent assigns strictly increasing ts even within one millisecond", async () => {
    const frozen = Date.now()
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(frozen)
    try {
      const a = await appendEvent({ runId: "run_1", type: "step_completed", stepId: "n_a" })
      const b = await appendEvent({ runId: "run_1", type: "step_completed", stepId: "n_b" })
      const c = await appendEvent({ runId: "run_1", type: "step_completed", stepId: "n_c" })
      expect(b.ts).toBeGreaterThan(a.ts)
      expect(c.ts).toBeGreaterThan(b.ts)

      const events = await listRunEvents("run_1")
      expect(events.map((e) => e.stepId)).toEqual(["n_a", "n_b", "n_c"])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("appendEvents preserves input order within one millisecond and chains after singles", async () => {
    const frozen = Date.now()
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(frozen)
    try {
      const single = await appendEvent({ runId: "run_2", type: "step_started", stepId: "s0" })
      await appendEvents([
        { runId: "run_2", type: "step_completed", stepId: "s1" },
        { runId: "run_2", type: "step_completed", stepId: "s2" },
        { runId: "run_2", type: "step_completed", stepId: "s3" },
      ])
      const events = await listRunEvents("run_2")
      expect(events.map((e) => e.stepId)).toEqual(["s0", "s1", "s2", "s3"])
      // The batch continued the watermark past the earlier single append.
      expect(events[1].ts).toBeGreaterThan(single.ts)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("coalesces a synchronous burst of events into a single bulkPut", async () => {
    const bulkSpy = jest.spyOn(getDb().workflowRunEvents, "bulkPut")
    // Emit three events WITHOUT awaiting between them (same microtask).
    const p1 = enqueueRunEvent({ runId: "run_c", type: "step_started", stepId: "b1" })
    const p2 = enqueueRunEvent({ runId: "run_c", type: "step_completed", stepId: "b2" })
    const p3 = enqueueRunEvent({ runId: "run_c", type: "step_completed", stepId: "b3" })
    const rows = await Promise.all([p1, p2, p3])
    // All three landed in ONE bulkPut, not three separate puts.
    expect(bulkSpy).toHaveBeenCalledTimes(1)
    expect(bulkSpy.mock.calls[0][0]).toHaveLength(3)
    // ts assigned at enqueue → order preserved on read.
    expect(rows[1].ts).toBeGreaterThan(rows[0].ts)
    const events = await listRunEvents("run_c")
    expect(events.map((e) => e.stepId)).toEqual(["b1", "b2", "b3"])
    bulkSpy.mockRestore()
  })

  it("isolates a bulkPut rejection to the failing run, not concurrent runs", async () => {
    const real = getDb().workflowRunEvents.bulkPut.bind(getDb().workflowRunEvents)
    const bulkSpy = jest
      .spyOn(getDb().workflowRunEvents, "bulkPut")
      .mockImplementation(((rows: WorkflowRunEventRow[]) =>
        rows[0]?.runId === "run_bad" ? Promise.reject(new Error("idb boom")) : real(rows)) as never)

    // Two runs enqueued in the SAME microtask → coalesced, then split per-run.
    const good = enqueueRunEvent({ runId: "run_good", type: "step_completed", stepId: "g1" })
    const bad = enqueueRunEvent({ runId: "run_bad", type: "step_completed", stepId: "b1" })

    await expect(bad).rejects.toThrow("idb boom")
    // The healthy run still resolves + persists despite the other run's failure.
    await expect(good).resolves.toMatchObject({ runId: "run_good", stepId: "g1" })
    const events = await listRunEvents("run_good")
    expect(events.map((e) => e.stepId)).toEqual(["g1"])

    bulkSpy.mockRestore()
  })

  it("createRunLogger writes are durable after await", async () => {
    const logger = createRunLogger("run_d")
    await logger.stepStarted("n1", { foo: 1 })
    await logger.stepCompleted("n1", { ok: true })
    const events = await listRunEvents("run_d")
    expect(events.map((e) => e.type)).toEqual(["step_started", "step_completed"])
  })

  it("persists commentary on a channel distinct from final output streaming", async () => {
    const logger = createRunLogger("run_commentary")
    await logger.stepCommentary("n1", "Checking the repository", 0)
    await logger.stepStream("n1", "Final answer", 0)

    const events = await listRunEvents("run_commentary")
    expect(events.map((event) => event.type)).toEqual(["step_commentary", "step_stream"])
    expect(events[0].payload).toEqual({ delta: "Checking the repository", seq: 0 })
  })

  it("mirrors every workflow lifecycle outcome into typed behavior telemetry", async () => {
    const logger = createRunLogger("run_lifecycle")
    await logger.runStarted({ trigger: { kind: "trigger.manual" } })
    await logger.runCompleted({ ok: true })
    await logger.runFailed({ message: "private failure", code: "timeout" })

    expect(mockTrackEvent.mock.calls).toEqual([
      ["workflow.run.started", { runId: "run_lifecycle", trigger: "trigger.manual" }],
      ["workflow.run.completed", expect.objectContaining({ runId: "run_lifecycle" })],
      [
        "workflow.run.failed",
        expect.objectContaining({ runId: "run_lifecycle", errorCode: "timeout" }),
      ],
    ])
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("private failure")
  })

  it("normalizes missing or malformed workflow telemetry metadata", async () => {
    const logger = createRunLogger("run_unknown")
    await logger.runStarted()
    await logger.runStarted({ trigger: "manual" })
    await logger.runStarted({ trigger: { kind: null } })
    await logger.runFailed({ message: "private failure" })

    expect(mockTrackEvent.mock.calls).toEqual([
      ["workflow.run.started", { runId: "run_unknown", trigger: "unknown" }],
      ["workflow.run.started", { runId: "run_unknown", trigger: "unknown" }],
      ["workflow.run.started", { runId: "run_unknown", trigger: "unknown" }],
      ["workflow.run.failed", expect.not.objectContaining({ errorCode: expect.anything() })],
    ])
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("private failure")
  })

  it("listRunEvents only returns the requested run's events", async () => {
    await appendEvent({ runId: "run_a", type: "step_completed", stepId: "x" })
    await appendEvent({ runId: "run_b", type: "step_completed", stepId: "y" })
    const events = await listRunEvents("run_a")
    expect(events).toHaveLength(1)
    expect(events[0].stepId).toBe("x")
  })
})

describe("createRunLogger().stepUsage", () => {
  it("appends a step_usage event AND shadow-writes the unified billing row", async () => {
    const logger = createRunLogger("run_x")
    await logger.stepUsage("n1", {
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      cacheReadTokens: 30,
      costUsd: 0.01,
      modelId: "gpt-4o",
      providerId: "openai",
    })
    // Durable event log carries the raw StepUsage payload.
    const events = await listRunEvents("run_x")
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("step_usage")

    // The fire-and-forget shadow write lands a workflow row (sessionId wf:run_x).
    // Poll briefly since the billing mirror is intentionally not awaited.
    let rows = await listUsageForSession("wf:run_x")
    for (let i = 0; i < 10 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
      rows = await listUsageForSession("wf:run_x")
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      messageId: "wf:run_x:n1",
      surface: "workflow",
      model: "gpt-4o",
      cacheReadTokens: 30,
      costUsd: 0.01,
    })
  })
})
