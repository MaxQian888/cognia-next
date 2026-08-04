import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listRunEvents } from "./event-log"
import {
  __resetResumersForTesting,
  findLatestCheckpoint,
  getLongStepResumer,
  registerLongStepResumer,
  resumeLongStep,
  runLongStep,
} from "./long-step-runner"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
  __resetResumersForTesting()
})
afterAll(dbFixture.dispose)

describe("runLongStep", () => {
  it("writes a checkpoint event to the durable log", async () => {
    const handle = runLongStep({
      runId: "run_1",
      stepId: "step_x",
      checkpointKey: "phase-1",
      initialState: { progress: 0 },
      run: async (ctx) => {
        await ctx.checkpoint({ progress: 50 })
        return "done"
      },
    })
    const result = await handle.promise
    expect(result).toBe("done")
    const events = await listRunEvents("run_1")
    const checkpoint = events.find((e) => e.type === "step.long_running.checkpoint")
    expect(checkpoint).toBeDefined()
    expect(checkpoint?.stepId).toBe("step_x")
    expect(checkpoint?.payload).toEqual({
      checkpointKey: "phase-1",
      state: { progress: 50 },
    })
  })

  it("emits progress events to both listeners and the event log", async () => {
    const seen: string[] = []
    const handle = runLongStep({
      runId: "run_progress",
      stepId: "step_y",
      checkpointKey: "k",
      initialState: null,
      run: async (ctx) => {
        await ctx.progress("starting")
        await ctx.progress("midway", { items: 5 })
        return 42
      },
    })
    const unsub = handle.onProgress((e) => seen.push(e.message))
    await handle.promise
    unsub()
    expect(seen).toEqual(["starting", "midway"])
    const events = await listRunEvents("run_progress")
    const progressEvents = events.filter((e) => e.type === "step.long_running.progress")
    expect(progressEvents).toHaveLength(2)
    const midway = progressEvents.find(
      (e) => (e.payload as { message?: string }).message === "midway"
    )
    expect((midway?.payload as { data?: unknown }).data).toEqual({ items: 5 })
  })

  it("aborts when handle.abort() is called mid-run", async () => {
    let started = false
    const handle = runLongStep({
      runId: "run_abort",
      stepId: "step_z",
      checkpointKey: "k",
      initialState: 0,
      run: async (ctx) =>
        new Promise<string>((resolve, reject) => {
          started = true
          if (ctx.signal.aborted) {
            reject(new Error("aborted"))
            return
          }
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))
          setTimeout(() => resolve("never"), 60_000).unref?.()
        }),
    })
    for (let i = 0; i < 10 && !started; i += 1) await Promise.resolve()
    handle.abort("user-cancelled")
    await expect(handle.promise).rejects.toThrow(/aborted/)
  })

  it("propagates an external abort signal that fires mid-run", async () => {
    const ac = new AbortController()
    let started = false
    const handle = runLongStep({
      runId: "run_ext_abort",
      stepId: "step_e",
      checkpointKey: "k",
      initialState: 0,
      signal: ac.signal,
      run: async (ctx) =>
        new Promise<string>((_resolve, reject) => {
          started = true
          if (ctx.signal.aborted) {
            reject(new Error("external-abort"))
            return
          }
          ctx.signal.addEventListener("abort", () => reject(new Error("external-abort")))
        }),
    })
    for (let i = 0; i < 10 && !started; i += 1) await Promise.resolve()
    ac.abort()
    await expect(handle.promise).rejects.toThrow(/external-abort/)
  })

  it("inherits an already-aborted external signal", async () => {
    const ac = new AbortController()
    ac.abort()
    const handle = runLongStep({
      runId: "run_pre_abort",
      stepId: "step_p",
      checkpointKey: "k",
      initialState: 0,
      signal: ac.signal,
      run: async (ctx) =>
        new Promise<string>((_r, reject) => {
          if (ctx.signal.aborted) reject(new Error("pre-aborted"))
        }),
    })
    await expect(handle.promise).rejects.toThrow(/pre-aborted/)
  })

  it("listener exceptions don't break the run", async () => {
    const handle = runLongStep({
      runId: "run_listener",
      stepId: "step_l",
      checkpointKey: "k",
      initialState: 0,
      run: async (ctx) => {
        await ctx.progress("a")
        return "ok"
      },
    })
    handle.onProgress(() => {
      throw new Error("listener boom")
    })
    await expect(handle.promise).resolves.toBe("ok")
  })

  it("findLatestCheckpoint returns the most recent state for the step", () => {
    const events = [
      {
        id: "1",
        runId: "r",
        ts: 1,
        type: "step.long_running.checkpoint" as const,
        stepId: "s",
        payload: { checkpointKey: "k", state: { progress: 10 } },
      },
      {
        id: "2",
        runId: "r",
        ts: 2,
        type: "step.long_running.checkpoint" as const,
        stepId: "s",
        payload: { checkpointKey: "k", state: { progress: 80 } },
      },
      {
        id: "3",
        runId: "r",
        ts: 3,
        type: "step.long_running.checkpoint" as const,
        stepId: "other",
        payload: { checkpointKey: "k", state: { progress: 999 } },
      },
    ]
    const latest = findLatestCheckpoint(events, "s")
    expect(latest).toEqual({ checkpointKey: "k", state: { progress: 80 } })
  })

  it("findLatestCheckpoint returns null when no checkpoint exists", () => {
    expect(findLatestCheckpoint([], "s")).toBeNull()
  })

  it("self-resumes by replaying the latest checkpoint via onResume", async () => {
    // First pass — write checkpoints, then throw to simulate a crash.
    const first = runLongStep({
      runId: "run_self_resume",
      stepId: "step_s",
      checkpointKey: "phase",
      initialState: { progress: 0 },
      run: async (ctx) => {
        await ctx.checkpoint({ progress: 70 })
        await new Promise((r) => setTimeout(r, 2))
        await ctx.checkpoint({ progress: 90 })
        throw new Error("simulated-crash")
      },
    })
    await expect(first.promise).rejects.toThrow(/simulated-crash/)

    // Second pass — same runId+stepId+checkpointKey. onResume should fire
    // with the latest persisted state (progress: 90).
    const seenState: Array<{ progress: number }> = []
    const second = runLongStep({
      runId: "run_self_resume",
      stepId: "step_s",
      checkpointKey: "phase",
      initialState: { progress: 0 },
      onResume: async (state) => {
        seenState.push(state as { progress: number })
        return state
      },
      run: async (ctx) => {
        return `resumed-with:${(ctx.state as { progress: number }).progress}`
      },
    })
    const out = await second.promise
    expect(out).toBe("resumed-with:90")
    expect(seenState).toEqual([{ progress: 90 }])
  })

  it("onResume returning false aborts the resumed step", async () => {
    const first = runLongStep({
      runId: "run_abandon",
      stepId: "step_a",
      checkpointKey: "phase",
      initialState: { x: 0 },
      run: async (ctx) => {
        await ctx.checkpoint({ x: 1 })
        return "ok"
      },
    })
    await first.promise
    const second = runLongStep({
      runId: "run_abandon",
      stepId: "step_a",
      checkpointKey: "phase",
      initialState: { x: 0 },
      onResume: async () => false,
      run: async () => "should-not-run",
    })
    await expect(second.promise).rejects.toThrow(/abandoned the prior checkpoint/)
  })

  it("checkpoint with a different key does not trigger onResume", async () => {
    const first = runLongStep({
      runId: "run_other_key",
      stepId: "step_o",
      checkpointKey: "phase-1",
      initialState: 0,
      run: async (ctx) => {
        await ctx.checkpoint(99)
        return "first"
      },
    })
    await first.promise
    const onResume = jest.fn(async (s) => s)
    const second = runLongStep({
      runId: "run_other_key",
      stepId: "step_o",
      checkpointKey: "phase-2", // different key
      initialState: 0,
      onResume,
      run: async (ctx) => `fresh:${ctx.state}`,
    })
    await expect(second.promise).resolves.toBe("fresh:0")
    expect(onResume).not.toHaveBeenCalled()
  })
})

describe("registerLongStepResumer / getLongStepResumer", () => {
  it("registers and unregisters a resumer", () => {
    const r = jest.fn(async () => "ok")
    const off = registerLongStepResumer("k1", r)
    expect(getLongStepResumer("k1")).toBe(r)
    off()
    expect(getLongStepResumer("k1")).toBeUndefined()
  })

  it("unregister is a no-op when a different resumer replaced it", () => {
    const r1 = jest.fn(async () => "a")
    const r2 = jest.fn(async () => "b")
    const off = registerLongStepResumer("k2", r1)
    registerLongStepResumer("k2", r2)
    off()
    expect(getLongStepResumer("k2")).toBe(r2)
  })
})

describe("resumeLongStep", () => {
  it("returns ok:false when no resumer is registered", async () => {
    const out = await resumeLongStep("run_x", "step_x", "missing")
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("no resumer registered") })
  })

  it("returns null when no checkpoint exists for the step", async () => {
    registerLongStepResumer("k", jest.fn())
    const out = await resumeLongStep("run_no_ckpt", "step_x", "k")
    expect(out).toBeNull()
  })

  it("invokes the resumer with the latest state on resume", async () => {
    const handle = runLongStep({
      runId: "run_resume",
      stepId: "step_r",
      checkpointKey: "phase",
      initialState: { stage: "init" },
      run: async (ctx) => {
        await ctx.checkpoint({ stage: "midway" })
        await new Promise((r) => setTimeout(r, 2))
        await ctx.checkpoint({ stage: "almost-done" })
        return "completed"
      },
    })
    await handle.promise
    const resumer = jest.fn(async ({ state }) => `resumed:${(state as { stage: string }).stage}`)
    registerLongStepResumer("phase", resumer)
    const out = await resumeLongStep("run_resume", "step_r", "phase")
    expect(out).toEqual({ ok: true, result: "resumed:almost-done" })
    expect(resumer).toHaveBeenCalledWith({
      runId: "run_resume",
      stepId: "step_r",
      checkpointKey: "phase",
      state: { stage: "almost-done" },
    })
  })

  it("captures resumer errors and returns ok:false", async () => {
    const handle = runLongStep({
      runId: "run_err",
      stepId: "step_e",
      checkpointKey: "x",
      initialState: 0,
      run: async (ctx) => {
        await ctx.checkpoint(1)
        return "ok"
      },
    })
    await handle.promise
    registerLongStepResumer("x", async () => {
      throw new Error("resumer boom")
    })
    const out = await resumeLongStep("run_err", "step_e", "x")
    expect(out).toEqual({ ok: false, reason: "resumer boom" })
  })
})
