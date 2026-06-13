/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { appendEvent, appendEvents, createRunLogger, listRunEvents } from "./event-log"
import { listUsageForSession } from "@/lib/db/session-usage"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflowRunEvents.clear()
})

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
