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
