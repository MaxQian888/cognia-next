/**
 * @jest-environment node
 */
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { Loop } from "@/types/loop"
import { renderLoopIterationMessage } from "@/lib/loop/prompts"
import { LoopGoalConflict } from "@/lib/loop/runtime"
import { LOOP_EXPIRY_MS } from "@/lib/loop/interval"
import { runLoopStreaming, type LoopRunDeps } from "./loop-run"
import type { TuiAction } from "../state/types"

const reply = (text = "ok"): RunAndCaptureResult => ({
  text,
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
  usage: { inputTokens: 1, outputTokens: 1 },
})

const fakeLoop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "l1",
    sessionId: "s1",
    mode: "self_paced",
    safePrompt: "do x",
    generationId: "lg1",
    iterations: 0,
    tokensUsed: 0,
    parseFailureCount: 0,
    status: "active",
    config: {
      maxIterations: 2,
      maxTokens: 1000,
      minDelayMs: 60000,
      maxDelayMs: 3600000,
      maxParseFailures: 3,
    },
    ...over,
  }) as Loop

function harness(over: Partial<LoopRunDeps>): {
  deps: LoopRunDeps
  actions: TuiAction[]
  sent: string[]
  delays: number[]
} {
  const actions: TuiAction[] = []
  const sent: string[] = []
  const delays: number[] = []
  const deps: LoopRunDeps = {
    send: async (p) => {
      sent.push(p)
      return reply()
    },
    dispatch: (a) => actions.push(a),
    sessionId: "s1",
    config: { cwd: "/tmp" } as never,
    signal: new AbortController().signal,
    mode: "self_paced",
    prompt: "do x",
    ensureDb: async () => {},
    ensureSession: async () => {},
    appSettings: null,
    pauseLoop: async () => {},
    stopLoop: async () => {},
    delay: async (ms) => {
      delays.push(ms)
    },
    ...over,
  }
  return { deps, actions, sent, delays }
}

describe("runLoopStreaming — self-paced", () => {
  it("sends the iteration message, honours the model delay, and exits on completion", async () => {
    const loop = fakeLoop()
    const outcomes = [
      { kind: "continue" as const, userMessage: "[Loop iteration 2 of 2]\n\ndo x", delayMs: 1000 },
      {
        kind: "exit" as const,
        exit: "completed",
        resultingStatus: "completed",
        reason: "task done",
      },
    ]
    let i = 0
    const { deps, actions, sent, delays } = harness({
      createLoop: async () => loop,
      getLoop: async () => loop,
      handleTurn: (async () => outcomes[i++]) as never,
    })
    await runLoopStreaming(deps)

    expect(sent[0]).toBe(renderLoopIterationMessage(loop))
    expect(sent[1]).toBe("[Loop iteration 2 of 2]\n\ndo x")
    expect(delays).toEqual([1000])
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Loop completed: task done",
    })
  })

  it("ends with an error when the driver exits with an error status", async () => {
    const loop = fakeLoop()
    const { deps, actions } = harness({
      createLoop: async () => loop,
      getLoop: async () => loop,
      handleTurn: (async () => ({
        kind: "exit",
        exit: "parse_failed_too_many",
        resultingStatus: "error",
        reason: "too many parse failures",
      })) as never,
    })
    await runLoopStreaming(deps)
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "error",
      summary: "Loop error: too many parse failures",
    })
  })

  it("ends (paused) when the driver reports aborted", async () => {
    const loop = fakeLoop()
    const { deps, actions } = harness({
      createLoop: async () => loop,
      getLoop: async () => loop,
      handleTurn: (async () => ({ kind: "aborted" })) as never,
    })
    await runLoopStreaming(deps)
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Loop paused.",
    })
  })

  it("ends with an error when the loop row vanishes mid-run", async () => {
    const loop = fakeLoop()
    const { deps, actions } = harness({
      createLoop: async () => loop,
      getLoop: async () => undefined,
      handleTurn: (async () => ({ kind: "continue", userMessage: "x" })) as never,
    })
    await runLoopStreaming(deps)
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "error",
      summary: "Loop removed mid-run.",
    })
  })

  it("ends with an error and never sends when blocked by an active goal", async () => {
    const { deps, actions, sent } = harness({
      createLoop: async () => {
        throw new LoopGoalConflict("s1")
      },
    })
    await runLoopStreaming(deps)
    expect(sent).toEqual([])
    expect(actions).toEqual([
      {
        type: "ACTIVITY_END",
        status: "error",
        summary: "Loop blocked — an active goal is already driving this session.",
      },
    ])
  })
})

describe("runLoopStreaming — interval", () => {
  it("re-sends the raw prompt on a fixed cadence until the iteration cap", async () => {
    const { deps, actions, sent, delays } = harness({
      mode: "interval",
      prompt: "ping",
      intervalMs: 60_000,
      maxIterations: 2,
    })
    await runLoopStreaming(deps)

    expect(sent).toEqual(["ping", "ping"])
    expect(delays).toEqual([60_000])
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Loop finished after 2 iterations.",
    })
  })

  it("stops at the 7-day expiry before reaching the iteration cap", async () => {
    let calls = 0
    const { deps, actions, sent } = harness({
      mode: "interval",
      prompt: "ping",
      intervalMs: 60_000,
      maxIterations: 100,
      // First `now()` sets expiresAt at 0+EXPIRY; the next is just past it.
      now: () => (calls++ === 0 ? 0 : LOOP_EXPIRY_MS + 1),
    })
    await runLoopStreaming(deps)
    expect(sent).toEqual(["ping"])
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Loop reached its 7-day expiry.",
    })
  })
})

describe("loop continuation controls", () => {
  it.each(["pause", "stop"])("persists %s without processing a cancelled turn", async (action) => {
    const controller = new AbortController()
    const pauseLoop = jest.fn(async () => {})
    const stopLoop = jest.fn(async () => {})
    const handleTurn = jest.fn()
    const loop = fakeLoop()
    const { deps } = harness({
      signal: controller.signal,
      createLoop: async () => loop,
      getLoop: async () => loop,
      pauseLoop,
      stopLoop,
      handleTurn,
      send: async () => {
        controller.abort(action)
        return null
      },
    })
    await runLoopStreaming(deps)
    expect(handleTurn).not.toHaveBeenCalled()
    expect(action === "pause" ? pauseLoop : stopLoop).toHaveBeenCalledWith(loop.id)
  })

  it("resumes the same self-paced loop without resetting its identity", async () => {
    const loop = fakeLoop()
    const createLoop = jest.fn()
    const resumeLoop = jest.fn(async () => loop)
    const { deps, sent } = harness({
      action: "resume",
      continuation: { loopId: loop.id },
      createLoop,
      getLoop: async () => ({ ...loop, status: "paused" }),
      resumeLoop,
      handleTurn: (async () => ({
        kind: "exit",
        resultingStatus: "completed",
        reason: "done",
      })) as never,
    })
    await runLoopStreaming(deps)
    expect(createLoop).not.toHaveBeenCalled()
    expect(resumeLoop).toHaveBeenCalledWith(loop.id)
    expect(sent).toHaveLength(1)
  })

  it("does not replace a missing loop on resume", async () => {
    const createLoop = jest.fn()
    const { deps, sent, actions } = harness({
      action: "resume",
      continuation: { loopId: "missing" },
      createLoop,
      getLoop: async () => undefined,
    })
    await runLoopStreaming(deps)
    expect(createLoop).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(actions.at(-1)).toMatchObject({ message: expect.stringContaining("No paused loop") })
  })

  it("stops a paused loop without sending or creating", async () => {
    const stopLoop = jest.fn(async () => {})
    const { deps, sent } = harness({ action: "stop", continuation: { loopId: "l1" }, stopLoop })
    await runLoopStreaming(deps)
    expect(stopLoop).toHaveBeenCalledWith("l1")
    expect(sent).toEqual([])
  })

  it("retains interval count and expiry across pause/resume", async () => {
    const continuation = {}
    const controller = new AbortController()
    const first = harness({
      mode: "interval",
      maxIterations: 3,
      continuation,
      now: () => 100,
      signal: controller.signal,
      delay: async () => controller.abort("pause"),
    })
    await runLoopStreaming(first.deps)
    expect(first.sent).toHaveLength(1)
    expect(continuation).toMatchObject({ completed: 1, expiresAt: 100 + LOOP_EXPIRY_MS })
    const resumed = harness({
      mode: "interval",
      action: "resume",
      maxIterations: 3,
      continuation,
      now: () => 200,
    })
    await runLoopStreaming(resumed.deps)
    expect(resumed.sent).toHaveLength(2)
    const exhausted = harness({ ...resumed.deps, send: jest.fn(), action: "resume" })
    await runLoopStreaming(exhausted.deps)
    expect(exhausted.deps.send).not.toHaveBeenCalled()
  })

  it("does not send after a paused interval loop expires", async () => {
    const { deps, sent } = harness({
      mode: "interval",
      action: "resume",
      continuation: { completed: 1, expiresAt: 100 },
      now: () => 101,
    })
    await runLoopStreaming(deps)
    expect(sent).toEqual([])
  })
})
