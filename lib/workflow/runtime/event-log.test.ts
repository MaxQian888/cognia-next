/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { appendEvent, appendEvents, listRunEvents } from "./event-log"
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
