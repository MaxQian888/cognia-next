/**
 * @jest-environment node
 */
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { Goal } from "@/types/goal"
import { runGoalStreaming, type GoalRunDeps } from "./goal-run"
import type { TuiAction } from "../state/types"

const reply = (text: string): RunAndCaptureResult => ({
  text,
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
  usage: { inputTokens: 1, outputTokens: 1 },
})

const fakeGoal = (over: Partial<Goal> = {}): Goal =>
  ({
    id: "g1",
    safeObjective: "do the thing",
    generationId: "gen-1",
    ...over,
  }) as Goal

function baseDeps(over: Partial<GoalRunDeps> = {}): {
  deps: GoalRunDeps
  actions: TuiAction[]
  sent: string[]
} {
  const actions: TuiAction[] = []
  const sent: string[] = []
  const deps: GoalRunDeps = {
    send: async (p) => {
      sent.push(p)
      return reply("ok")
    },
    dispatch: (a) => actions.push(a),
    sessionId: "s1",
    config: { cwd: "/tmp" } as never,
    signal: new AbortController().signal,
    ensureDb: async () => {},
    ensureSession: async () => {},
    appSettings: null,
    createGoal: async () => fakeGoal(),
    buildJudge: () => ({}) as never,
    getSession: async () => ({}) as never,
    getGoal: async () => fakeGoal(),
    ...over,
  }
  return { deps, actions, sent }
}

describe("runGoalStreaming", () => {
  it("notices on an empty objective", async () => {
    const { deps, actions, sent } = baseDeps()
    await runGoalStreaming("   ", deps)
    expect(sent).toEqual([])
    expect(actions).toEqual([{ type: "NOTICE", message: "Usage: /goal <objective>" }])
  })

  it("sends the redacted objective first, then drives to the judge exit", async () => {
    const outcomes = [
      { kind: "continue" as const, userMessage: "keep going" },
      {
        kind: "exit" as const,
        resultingStatus: "completed",
        reason: "all met",
        exit: "judge_done",
      },
    ]
    let i = 0
    const { deps, actions, sent } = baseDeps({
      handleTurn: (async () => outcomes[i++]) as never,
    })
    await runGoalStreaming("do the thing", deps)

    expect(sent).toEqual(["do the thing", "keep going"])
    expect(actions[0]).toMatchObject({ type: "ACTIVITY_START", kind: "goal" })
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Goal completed: all met",
    })
  })

  it("ends with an error and never sends when no judge is available", async () => {
    const { deps, actions, sent } = baseDeps({ buildJudge: () => null })
    await runGoalStreaming("do x", deps)
    expect(sent).toEqual([])
    expect(actions).toContainEqual(
      expect.objectContaining({ type: "ACTIVITY_END", status: "error" })
    )
  })

  it("ends (paused) when the driver reports aborted", async () => {
    const { deps, actions } = baseDeps({ handleTurn: (async () => ({ kind: "aborted" })) as never })
    await runGoalStreaming("do x", deps)
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Goal paused.",
    })
  })

  it("ends with an error when the goal row vanishes mid-run", async () => {
    const { deps, actions } = baseDeps({ getGoal: async () => undefined })
    await runGoalStreaming("do x", deps)
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "error",
      summary: "Goal removed mid-run.",
    })
  })

  it("ends with an error on a stale outcome", async () => {
    const { deps, actions } = baseDeps({
      handleTurn: (async () => ({ kind: "stale", reason: "rotated" })) as never,
    })
    await runGoalStreaming("do x", deps)
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
  })

  it("surfaces a createGoal refusal (goal/loop mutex) as an error end", async () => {
    const { deps, actions, sent } = baseDeps({
      createGoal: async () => {
        throw new Error("loop blocked: session s1 has an active goal")
      },
    })
    await runGoalStreaming("do x", deps)
    expect(sent).toEqual([])
    expect(actions).toEqual([
      {
        type: "ACTIVITY_END",
        status: "error",
        summary: "loop blocked: session s1 has an active goal",
      },
    ])
  })
})
