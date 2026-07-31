import type { Goal, GoalConfig } from "@/types/goal"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { evaluateGoal } from "./judge"

const SAMPLE_CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionId: "ses_a",
    rawObjective: "write a haiku about winter",
    safeObjective: "write a haiku about winter",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 1,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: SAMPLE_CONFIG,
    generationId: "gen-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function mockClient(complete: jest.Mock): LlmClient {
  return { complete }
}

describe("evaluateGoal — happy path", () => {
  it("parses {done:true} and returns kind:decided", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "haiku produced"}')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "Snowflakes drift...",
      client: mockClient(complete),
    })
    expect(result.kind).toBe("decided")
    if (result.kind !== "decided") return
    expect(result.done).toBe(true)
    expect(result.reason).toBe("haiku produced")
  })

  it("parses {done:false} and returns kind:decided", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": false, "reason": "not yet"}')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "thinking...",
      client: mockClient(complete),
    })
    if (result.kind !== "decided") fail("expected decided")
    expect(result.done).toBe(false)
    expect(result.reason).toBe("not yet")
  })

  it("uses temperature 0 and maxTokens 200 by default", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": false, "reason": "x"}')
    await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ temperature: 0, maxTokens: 200 })
    )
  })

  it("honours custom maxTokens", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "x"}')
    await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      maxTokens: 50,
    })
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxTokens: 50 })
    )
  })

  it("passes JUDGE_SYSTEM_PROMPT as the system message", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "x"}')
    await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    const [, options] = complete.mock.calls[0]!
    expect((options as { system: string }).system).toMatch(/strict judge/)
  })
})

describe("evaluateGoal — judge customization (ADR-0019 Phase 2)", () => {
  it("honours an explicit temperature override", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "x"}')
    await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      temperature: 0.7,
    })
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ temperature: 0.7 })
    )
  })

  it("honours an explicit system override", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "x"}')
    await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      system: "CUSTOM JUDGE PERSONA",
    })
    const [, options] = complete.mock.calls[0]!
    expect((options as { system: string }).system).toBe("CUSTOM JUDGE PERSONA")
  })

  it("falls back to goal.config.judgeMaxTokens when the maxTokens arg is absent", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "x"}')
    await evaluateGoal({
      goal: buildGoal({ config: { ...SAMPLE_CONFIG, judgeMaxTokens: 80 } }),
      lastResponse: "x",
      client: mockClient(complete),
    })
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxTokens: 80 })
    )
  })
})

describe("evaluateGoal — parse_error fail-OPEN", () => {
  it("fails closed before the judge provider call when assembled text contains PII", async () => {
    const complete = jest.fn()
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "Contact jane@example.com",
      client: mockClient(complete),
    })

    expect(result).toEqual({
      kind: "parse_error",
      raw: "",
      error: "judge blocked by PII gate",
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it("returns parse_error when the response is not JSON", async () => {
    const complete = jest.fn().mockResolvedValue("not json at all")
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    expect(result.kind).toBe("parse_error")
    if (result.kind !== "parse_error") return
    expect(result.raw).toBe("not json at all")
    expect(result.error).toBeTruthy()
  })

  it("returns parse_error when 'done' is missing", async () => {
    const complete = jest.fn().mockResolvedValue('{"reason": "x"}')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    expect(result.kind).toBe("parse_error")
    if (result.kind !== "parse_error") return
    expect(result.error).toMatch(/non-boolean "done"/)
  })

  it("returns parse_error when 'done' is the wrong type", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": "yes", "reason": "x"}')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    expect(result.kind).toBe("parse_error")
  })

  it("tolerates a missing reason (defaults to empty string)", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true}')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    if (result.kind !== "decided") fail("expected decided")
    expect(result.done).toBe(true)
    expect(result.reason).toBe("")
  })

  it("treats an LLM provider exception as parse_error (network resilience)", async () => {
    const complete = jest.fn().mockRejectedValue(new Error("503 upstream"))
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    expect(result.kind).toBe("parse_error")
    if (result.kind !== "parse_error") return
    expect(result.error).toBe("503 upstream")
  })

  it("handles fenced JSON blocks via extractJson", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue('Sure!\n```json\n{"done": true, "reason": "ok"}\n```')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    if (result.kind !== "decided") fail("expected decided")
    expect(result.done).toBe(true)
  })
})

describe("evaluateGoal — abort", () => {
  it("returns aborted when the signal is already fired before call", async () => {
    const complete = jest.fn()
    const ac = new AbortController()
    ac.abort()
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      signal: ac.signal,
    })
    expect(result.kind).toBe("aborted")
    expect(complete).not.toHaveBeenCalled()
  })

  it("returns aborted when the signal fires during the LLM call", async () => {
    const ac = new AbortController()
    const complete = jest.fn().mockImplementation(() => {
      ac.abort()
      return Promise.reject(new Error("aborted by signal"))
    })
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      signal: ac.signal,
    })
    expect(result.kind).toBe("aborted")
  })

  it("returns aborted when the signal fires after a successful call but before parse", async () => {
    const ac = new AbortController()
    const complete = jest.fn().mockImplementation(() => {
      ac.abort()
      return Promise.resolve('{"done": true, "reason": "x"}')
    })
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      signal: ac.signal,
    })
    expect(result.kind).toBe("aborted")
  })
})

describe("evaluateGoal — completedSubgoals", () => {
  it("parses a valid completedSubgoals array of non-negative integers", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue('{"done": false, "reason": "wip", "completedSubgoals": [0, 2]}')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    if (result.kind !== "decided") fail("expected decided")
    expect(result.completedSubgoals).toEqual([0, 2])
  })

  it("sanitises non-integer / negative entries out", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(
        '{"done": false, "reason": "x", "completedSubgoals": [1, -3, "a", 2.5, 4]}'
      )
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    if (result.kind !== "decided") fail("expected decided")
    expect(result.completedSubgoals).toEqual([1, 4])
  })

  it("is undefined when the field is absent", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "done"}')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    if (result.kind !== "decided") fail("expected decided")
    expect(result.completedSubgoals).toBeUndefined()
  })

  it("is undefined when the field is malformed (not an array)", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue('{"done": false, "reason": "x", "completedSubgoals": "nope"}')
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
    })
    if (result.kind !== "decided") fail("expected decided")
    expect(result.completedSubgoals).toBeUndefined()
  })
})

describe("evaluateGoal — lifecycle hook bracketing (ADR-0040 follow-up)", () => {
  it("fires SessionStart, UserPromptSubmit, Stop, SessionEnd around a successful judge", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "ok"}')
    const events: string[] = []
    const firer = jest.fn(async (event: string) => {
      events.push(event)
      return null
    })
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      firer,
    })
    expect(result.kind).toBe("decided")
    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"])
  })

  it("returns parse_error when a UserPromptSubmit hook blocks the judge", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true, "reason": "ok"}')
    const firer = jest.fn(async (event: string) =>
      event === "UserPromptSubmit"
        ? { block: "daily judge budget exceeded", additionalContext: null, warnings: [] }
        : null
    )
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      firer,
    })
    expect(complete).not.toHaveBeenCalled()
    expect(result.kind).toBe("parse_error")
    if (result.kind !== "parse_error") return
    expect(result.error).toContain("daily judge budget exceeded")
  })

  it("appends pre-hook additionalContext to the judge system prompt", async () => {
    const complete = jest.fn().mockResolvedValue('{"done": false, "reason": "x"}')
    const firer = jest.fn(async (event: string) =>
      event === "SessionStart"
        ? { block: null, additionalContext: "PROJECT CONTEXT", warnings: [] }
        : null
    )
    await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      system: "BASE",
      firer,
    })
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ system: "BASE\n\nPROJECT CONTEXT" })
    )
  })

  it("fires StopFailure then SessionEnd when the judge call throws", async () => {
    const complete = jest.fn().mockRejectedValue(new Error("provider 500"))
    const events: string[] = []
    const firer = jest.fn(async (event: string) => {
      events.push(event)
      return null
    })
    const result = await evaluateGoal({
      goal: buildGoal(),
      lastResponse: "x",
      client: mockClient(complete),
      firer,
    })
    expect(result.kind).toBe("parse_error")
    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "StopFailure", "SessionEnd"])
  })
})
