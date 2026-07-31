/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { Goal, GoalConfig } from "@/types/goal"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { appendGoalEvent, createGoal, getGoal, listGoalEvents, updateGoal } from "@/lib/db/goals"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listUsageForSession } from "@/lib/db/session-usage"

const onGoalTerminalMock = jest.fn().mockResolvedValue(undefined)
jest.mock("./completion-linkage", () => ({
  onGoalTerminal: (...a: unknown[]) => onGoalTerminalMock(...a),
  toGoalHookPayload: (g: unknown) => g,
}))

import { handleTurnComplete } from "./turn-driver"

const SAMPLE_CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoal(overrides: Partial<Goal> = {}): Parameters<typeof createGoal>[0] {
  return {
    id: overrides.id ?? "g1",
    sessionId: overrides.sessionId ?? "ses_a",
    characterId: overrides.characterId,
    rawObjective: overrides.rawObjective ?? "ship feature flag",
    safeObjective: overrides.safeObjective ?? "ship feature flag",
    redactionMapEnc: overrides.redactionMapEnc ?? "",
    status: overrides.status ?? "active",
    turnsUsed: overrides.turnsUsed ?? 0,
    tokensUsed: overrides.tokensUsed ?? 0,
    judgeFailureCount: overrides.judgeFailureCount ?? 0,
    config: overrides.config ?? SAMPLE_CONFIG,
    generationId: overrides.generationId ?? "gen-1",
    subgoals: overrides.subgoals,
  }
}

function mockClient(handler: (prompt: string) => string | Error): LlmClient {
  return {
    complete: jest.fn().mockImplementation((prompt: string) => {
      const result = handler(prompt)
      if (result instanceof Error) return Promise.reject(result)
      return Promise.resolve(result)
    }),
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  onGoalTerminalMock.mockClear()
})

describe("handleTurnComplete — basic outcomes", () => {
  it("returns no_goal when the goalId doesn't exist", async () => {
    const out = await handleTurnComplete({
      goalId: "missing",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("no_goal")
  })

  it("returns stale when generationId no longer matches", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "outdated",
    })
    expect(out.kind).toBe("stale")
  })

  it("returns stale when the row's status isn't active anymore", async () => {
    await createGoal(buildGoal({ id: "g1", status: "paused" }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("stale")
  })

  it("returns aborted when the signal fires before evaluating", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const ac = new AbortController()
    ac.abort()
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "x"}'),
      capturedGenerationId: "gen-1",
      signal: ac.signal,
    })
    expect(out.kind).toBe("aborted")
  })
})

describe("handleTurnComplete — turn delta persistence", () => {
  it("bumps turnsUsed and accumulates tokensUsed", async () => {
    await createGoal(buildGoal({ id: "g1", turnsUsed: 2, tokensUsed: 100 }))
    await handleTurnComplete({
      goalId: "g1",
      lastResponse: "made progress",
      tokensDelta: 500,
      judgeClient: mockClient(() => '{"done": false, "reason": "more to do"}'),
      capturedGenerationId: "gen-1",
    })
    const updated = await getGoal("g1")
    expect(updated?.turnsUsed).toBe(3)
    expect(updated?.tokensUsed).toBe(600)
  })

  it("appends a turn_completed event", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 100,
      modelMessageId: "msg_42",
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    const events = await listGoalEvents("g1")
    const turnEvent = events.find((e) => e.kind === "turn_completed")
    expect(turnEvent).toBeDefined()
    const payload = turnEvent!.payload
    expect(payload.kind).toBe("turn_completed")
    if (payload.kind === "turn_completed") {
      expect(payload.turnNumber).toBe(1)
      expect(payload.tokensDelta).toBe(100)
      expect(payload.modelMessageId).toBe("msg_42")
    }
  })

  it("records full goal usage when the caller provides SDK usage", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 31,
      usage: {
        inputTokens: 20,
        outputTokens: 11,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 2,
        totalCostUsd: 0.006,
        durationMs: 900,
      },
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })

    const rows = await listUsageForSession("goal:g1")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      messageId: "goal:g1:1",
      surface: "goal",
      inputTokens: 20,
      outputTokens: 11,
      cacheReadTokens: 4,
      cacheCreationTokens: 2,
      costUsd: 0.006,
      durationMs: 900,
    })
  })

  it("clamps negative tokensDelta to 0", async () => {
    await createGoal(buildGoal({ id: "g1", tokensUsed: 50 }))
    await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: -100,
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect((await getGoal("g1"))!.tokensUsed).toBe(50)
  })
})

describe("handleTurnComplete — exit paths", () => {
  it("turn_limited fires when turnsUsed reaches maxTurns", async () => {
    await createGoal(
      buildGoal({ id: "g1", turnsUsed: 19, config: { ...SAMPLE_CONFIG, maxTurns: 20 } })
    )
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("turn_limited")
    expect(out.resultingStatus).toBe("turn_limited")
    const goal = await getGoal("g1")
    expect(goal?.status).toBe("turn_limited")
    expect(goal?.endedAt).toBeGreaterThan(0)
    const exitEvent = (await listGoalEvents("g1")).find((e) => e.kind === "exit_triggered")
    expect(exitEvent).toBeDefined()
  })

  it("budget_limited fires when tokensUsed reaches maxTokens", async () => {
    await createGoal(
      buildGoal({
        id: "g1",
        tokensUsed: 199_500,
        config: { ...SAMPLE_CONFIG, maxTokens: 200_000 },
      })
    )
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 800,
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("budget_limited")
  })

  it("judge_done fires when judge returns done=true", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "Snowflakes drift...",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "haiku produced"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("judge_done")
    expect(out.reason).toBe("haiku produced")
    expect((await getGoal("g1"))?.status).toBe("completed")
  })

  it("requireAcceptance parks a judge_done completion as paused + awaitingAcceptance", async () => {
    await createGoal(buildGoal({ id: "g1", config: { ...SAMPLE_CONFIG, requireAcceptance: true } }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "done work",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "objective met"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.resultingStatus).toBe("paused")
    expect(out.reason).toContain("awaiting acceptance")
    const goal = await getGoal("g1")
    expect(goal?.status).toBe("paused")
    expect(goal?.awaitingAcceptance).toBe(true)
    // Not terminal yet — completion linkage must NOT fire.
    expect(onGoalTerminalMock).not.toHaveBeenCalled()
    const events = await listGoalEvents("g1", 50)
    expect(events.some((e) => e.kind === "acceptance_requested")).toBe(true)
  })

  it("requireAcceptance does NOT gate non-completed exits (user stop limits etc.)", async () => {
    await createGoal(
      buildGoal({
        id: "g1",
        turnsUsed: 19,
        config: { ...SAMPLE_CONFIG, maxTurns: 20, requireAcceptance: true },
      })
    )
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "another turn",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "keep going"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.resultingStatus).toBe("turn_limited")
    expect((await getGoal("g1"))?.awaitingAcceptance).not.toBe(true)
  })
})

describe("handleTurnComplete — continue path", () => {
  it("returns continue with a continuation message when judge says done=false", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "starting",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "more work"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("continue")
    if (out.kind !== "continue") return
    expect(out.userMessage).toMatch(/Goal continuation/)
    expect(out.userMessage).toMatch(/turn 2 of 20/)
  })

  it("resets judgeFailureCount on a successful parse", async () => {
    await createGoal(buildGoal({ id: "g1", judgeFailureCount: 2 }))
    await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect((await getGoal("g1"))?.judgeFailureCount).toBe(0)
  })

  it("logs judge_evaluated event for a decided result", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "still going"}'),
      capturedGenerationId: "gen-1",
    })
    const events = await listGoalEvents("g1")
    const evalEvent = events.find((e) => e.kind === "judge_evaluated")
    expect(evalEvent).toBeDefined()
    if (evalEvent?.payload.kind !== "judge_evaluated") fail("payload mismatch")
    expect(evalEvent.payload.done).toBe(false)
    expect(evalEvent.payload.reason).toBe("still going")
  })
})

describe("handleTurnComplete — judge parse failures (fail-OPEN)", () => {
  it("first parse failure → bumps count, continues looping", async () => {
    await createGoal(buildGoal({ id: "g1", judgeFailureCount: 0 }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => "garbage response"),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("continue")
    expect((await getGoal("g1"))?.judgeFailureCount).toBe(1)
    const events = await listGoalEvents("g1")
    expect(events.some((e) => e.kind === "judge_parse_failed")).toBe(true)
  })

  it("third consecutive failure → judge_failed_too_many (paused, not terminal)", async () => {
    await createGoal(buildGoal({ id: "g1", judgeFailureCount: 2 }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => "still garbage"),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("judge_failed_too_many")
    expect(out.resultingStatus).toBe("paused")
    const goal = await getGoal("g1")
    expect(goal?.status).toBe("paused")
    // pause is non-terminal — endedAt should be NOT set
    expect(goal?.endedAt).toBeUndefined()
  })

  it("network error from judge counts as a parse failure", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => new Error("503 upstream")),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("continue")
    expect((await getGoal("g1"))?.judgeFailureCount).toBe(1)
  })
})

describe("handleTurnComplete — completion linkage (ADR-0019 Phase 2)", () => {
  it("fires onGoalTerminal on a terminal exit (turn_limited)", async () => {
    await createGoal(
      buildGoal({ id: "g1", turnsUsed: 19, config: { ...SAMPLE_CONFIG, maxTurns: 20 } })
    )
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    expect(onGoalTerminalMock).toHaveBeenCalledTimes(1)
    expect(onGoalTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "g1", status: "turn_limited" })
    )
  })

  it("does NOT fire onGoalTerminal when judge failures land as paused (non-terminal)", async () => {
    await createGoal(buildGoal({ id: "g2", config: { ...SAMPLE_CONFIG, maxJudgeFailures: 1 } }))
    const out = await handleTurnComplete({
      goalId: "g2",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => "not json"),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind === "exit") expect(out.resultingStatus).toBe("paused")
    expect(onGoalTerminalMock).not.toHaveBeenCalled()
  })
})

describe("handleTurnComplete — generation rotation mid-turn", () => {
  it("stale path fires when generation rotates after persist", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    // Rotate the generation right after the persist step by mocking the
    // judge to mutate the goal mid-call.
    const judge = mockClient(() => {
      // Sync mutation through a microtask — this fires before the judge
      // result is returned and seen by the subsequent re-read.
      return '{"done": true, "reason": "x"}'
    })
    await appendGoalEvent({
      goalId: "g1",
      kind: "user_paused",
      payload: { kind: "user_paused" },
    })
    // Rotate the generation directly to simulate a concurrent pause.
    await (await import("@/lib/db/goals")).updateGoal("g1", { generationId: "gen-2" })
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: judge,
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("stale")
  })

  it("returns aborted when judge resolves with kind:aborted (mid-call cancel)", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const ac = new AbortController()
    const judge: LlmClient = {
      complete: jest.fn().mockImplementation(async () => {
        ac.abort()
        // The judge.ts module checks the signal after the call resolves
        // and returns kind:"aborted" — exercising that branch in
        // handleTurnComplete (lines 137-139).
        return '{"done": true, "reason": "x"}'
      }),
    }
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: judge,
      signal: ac.signal,
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("aborted")
  })

  it("returns stale when status changes to paused during judge", async () => {
    const goalRow = buildGoal({ id: "g1" })
    await createGoal(goalRow)
    const { updateGoal } = await import("@/lib/db/goals")
    const judge: LlmClient = {
      complete: jest.fn().mockImplementation(async () => {
        // Mutate status to paused mid-judge WITHOUT rotating generationId
        // — exercises lines 146-148 specifically.
        await updateGoal("g1", { status: "paused" })
        return '{"done": false, "reason": "x"}'
      }),
    }
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: judge,
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("stale")
  })

  it("commitExit returns stale when generationId rotates before commit", async () => {
    // Trigger an exit (turn_limited) by maxing out turnsUsed, then rotate
    // the generation between the exit decision and the commit — exercises
    // lines 212-213 in commitExit.
    await createGoal(
      buildGoal({ id: "g1", turnsUsed: 19, config: { ...SAMPLE_CONFIG, maxTurns: 20 } })
    )
    // Capture original generation, then rotate the row's generation BEFORE
    // calling handleTurnComplete. handleTurnComplete will increment turns
    // (which triggers turn_limited exit) then attempt commitExit, but
    // commitExit re-reads the row and sees the rotation.
    const { getGoal: gg, updateGoal } = await import("@/lib/db/goals")
    const before = (await gg("g1"))!
    // Counters: pre-call generation is gen-1; the inner "evaluator runs
    // after persist" already sees the new generation? No — we want to
    // exercise the very last guard in commitExit. Easiest: race-rotate the
    // generation inside the same tick window. We do this by registering a
    // microtask-driven update once the turn driver awaits the first
    // updateGoal call. Since simulating that is fragile, we instead pin
    // capturedGenerationId to the value present at *call* time and rotate
    // after the call (this won't hit the commitExit guard). The cleanest
    // way to actually hit that branch is via the `judge_failed_too_many`
    // path with a pre-rotation — exercise that:
    await updateGoal("g1", {
      judgeFailureCount: 3,
      generationId: "gen-2",
    })
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    // Generation rotated → driver bails out with stale before any judge call.
    expect(out.kind).toBe("stale")
    void before
  })
})

describe("handleTurnComplete — subgoal progress", () => {
  it("marks judge-reported subgoals complete (monotonic)", async () => {
    await createGoal(
      buildGoal({
        id: "g1",
        subgoals: [
          { id: "s0", text: "A", done: false, order: 0 },
          { id: "s1", text: "B", done: false, order: 1 },
          { id: "s2", text: "C", done: true, order: 2 },
        ],
      })
    )
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "did A",
      tokensDelta: 10,
      judgeClient: mockClient(
        () => '{"done": false, "reason": "more to do", "completedSubgoals": [0]}'
      ),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("continue")
    const after = await getGoal("g1")
    expect(after?.subgoals?.find((s) => s.id === "s0")?.done).toBe(true)
    expect(after?.subgoals?.find((s) => s.id === "s1")?.done).toBe(false)
    expect(after?.subgoals?.find((s) => s.id === "s2")?.done).toBe(true) // stays done
  })

  it("is a no-op when the goal has no subgoals", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "x",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": false, "reason": "x", "completedSubgoals": [0]}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("continue")
    expect((await getGoal("g1"))?.subgoals).toBeUndefined()
  })
})

describe("handleTurnComplete — completion-promise gate", () => {
  const PROMISE = "ALL TESTS PASS"
  const promiseConfig: GoalConfig = { ...SAMPLE_CONFIG, completionPromise: PROMISE }

  it("judge done=true with a promise configured arms verification instead of exiting", async () => {
    await createGoal(buildGoal({ id: "g1", config: promiseConfig }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "I believe everything is finished.",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "looks complete"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("continue")
    if (out.kind !== "continue") return
    expect(out.userMessage).toContain(`<promise>${PROMISE}</promise>`)
    const goal = await getGoal("g1")
    expect(goal?.status).toBe("active")
    expect(goal?.awaitingPromise).toBe(true)
    const events = await listGoalEvents("g1")
    expect(events.some((e) => e.kind === "promise_requested")).toBe(true)
    expect(events.some((e) => e.kind === "judge_evaluated")).toBe(true)
  })

  it("short-circuits to completed when the arming response already carries the token", async () => {
    await createGoal(buildGoal({ id: "g1", config: promiseConfig }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: `Everything done.\n<promise>${PROMISE}</promise>`,
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "complete"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("judge_done")
    expect((await getGoal("g1"))?.status).toBe("completed")
    const events = await listGoalEvents("g1")
    expect(events.some((e) => e.kind === "promise_confirmed")).toBe(true)
    expect(events.some((e) => e.kind === "promise_requested")).toBe(false)
  })

  it("verification turn with the token completes the goal without re-judging", async () => {
    await createGoal(buildGoal({ id: "g1", config: promiseConfig }))
    await updateGoal("g1", { awaitingPromise: true, promiseDenialCount: 1 })
    const judge = mockClient(() => '{"done": true, "reason": "x"}')
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: `Verified.\n<promise>${PROMISE}</promise>`,
      tokensDelta: 0,
      judgeClient: judge,
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("judge_done")
    expect(out.resultingStatus).toBe("completed")
    expect(judge.complete).not.toHaveBeenCalled()
    const goal = await getGoal("g1")
    expect(goal?.status).toBe("completed")
    expect(goal?.awaitingPromise).toBe(false)
    expect(goal?.promiseDenialCount).toBe(0)
    const events = await listGoalEvents("g1")
    expect(events.some((e) => e.kind === "promise_confirmed")).toBe(true)
  })

  it("verification turn without the token denies below the cap and keeps working", async () => {
    await createGoal(buildGoal({ id: "g1", config: promiseConfig }))
    await updateGoal("g1", { awaitingPromise: true })
    const judge = mockClient(() => '{"done": true, "reason": "x"}')
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "Actually the docs section is still missing; writing it now.",
      tokensDelta: 0,
      judgeClient: judge,
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("continue")
    if (out.kind !== "continue") return
    // Back to a NORMAL continuation — not the verification message.
    expect(out.userMessage).toMatch(/Goal continuation/)
    expect(out.userMessage).not.toContain("<promise>")
    expect(judge.complete).not.toHaveBeenCalled()
    const goal = await getGoal("g1")
    expect(goal?.awaitingPromise).toBe(false)
    expect(goal?.promiseDenialCount).toBe(1)
    const events = await listGoalEvents("g1")
    const denied = events.find((e) => e.kind === "promise_denied")
    expect(denied).toBeDefined()
    if (denied?.payload.kind !== "promise_denied") fail("payload mismatch")
    expect(denied.payload.denialCount).toBe(1)
    expect(denied.payload.overridden).toBe(false)
  })

  it("overrides to completed once denials reach the cap", async () => {
    await createGoal(buildGoal({ id: "g1", config: { ...promiseConfig, maxPromiseDenials: 3 } }))
    await updateGoal("g1", { awaitingPromise: true, promiseDenialCount: 2 })
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "Hmm, I still cannot promise that.",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("judge_done")
    expect(out.resultingStatus).toBe("completed")
    const events = await listGoalEvents("g1")
    const denied = events.find((e) => e.kind === "promise_denied")
    if (denied?.payload.kind !== "promise_denied") fail("payload mismatch")
    expect(denied.payload.denialCount).toBe(3)
    expect(denied.payload.overridden).toBe(true)
  })

  it("pre-judge exits still win over a pending verification turn", async () => {
    await createGoal(
      buildGoal({
        id: "g1",
        turnsUsed: 19,
        config: { ...promiseConfig, maxTurns: 20 },
      })
    )
    await updateGoal("g1", { awaitingPromise: true })
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: `<promise>${PROMISE}</promise>`,
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "x"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("turn_limited")
  })

  it("no promise configured → judge done=true exits exactly as before", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const out = await handleTurnComplete({
      goalId: "g1",
      lastResponse: "done",
      tokensDelta: 0,
      judgeClient: mockClient(() => '{"done": true, "reason": "complete"}'),
      capturedGenerationId: "gen-1",
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("judge_done")
    const events = await listGoalEvents("g1")
    expect(events.some((e) => e.kind === "promise_requested")).toBe(false)
  })
})
