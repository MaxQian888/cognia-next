import type { Goal, GoalSubgoal } from "@/types/goal"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { decomposeObjective, markSubgoalsComplete, toSubgoals, MAX_SUBGOALS } from "./subgoals"

function goal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionId: "ses",
    rawObjective: "ship the feature",
    safeObjective: "ship the feature",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    generationId: "gen",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function client(complete: jest.Mock): LlmClient {
  return { complete }
}

describe("decomposeObjective", () => {
  it("parses a steps array into cleaned strings", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue('{"steps": ["Write tests", "Implement feature", "Open PR"]}')
    const steps = await decomposeObjective({ goal: goal(), client: client(complete) })
    expect(steps).toEqual(["Write tests", "Implement feature", "Open PR"])
  })

  it("only sends the redacted safeObjective", async () => {
    const complete = jest.fn().mockResolvedValue('{"steps": ["a"]}')
    await decomposeObjective({
      goal: goal({ rawObjective: "secret@example.com plan", safeObjective: "[email] plan" }),
      client: client(complete),
    })
    const userPrompt = complete.mock.calls[0][0] as string
    expect(userPrompt).toContain("[email] plan")
    expect(userPrompt).not.toContain("secret@example.com")
  })

  it("trims, drops empties, and de-duplicates", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue('{"steps": ["  Step A  ", "", "step a", "Step B", 42]}')
    const steps = await decomposeObjective({ goal: goal(), client: client(complete) })
    expect(steps).toEqual(["Step A", "Step B"])
  })

  it("caps at MAX_SUBGOALS", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `Step ${i}`)
    const complete = jest.fn().mockResolvedValue(JSON.stringify({ steps: many }))
    const steps = await decomposeObjective({ goal: goal(), client: client(complete) })
    expect(steps).toHaveLength(MAX_SUBGOALS)
  })

  it("fails OPEN to [] on unparseable output", async () => {
    const complete = jest.fn().mockResolvedValue("not json at all")
    expect(await decomposeObjective({ goal: goal(), client: client(complete) })).toEqual([])
  })

  it("fails OPEN to [] on network error", async () => {
    const complete = jest.fn().mockRejectedValue(new Error("boom"))
    expect(await decomposeObjective({ goal: goal(), client: client(complete) })).toEqual([])
  })

  it("returns [] without calling the model when already aborted", async () => {
    const complete = jest.fn()
    const ac = new AbortController()
    ac.abort()
    expect(
      await decomposeObjective({ goal: goal(), client: client(complete), signal: ac.signal })
    ).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it("returns [] when steps is missing or not an array", async () => {
    const complete = jest.fn().mockResolvedValue('{"foo": "bar"}')
    expect(await decomposeObjective({ goal: goal(), client: client(complete) })).toEqual([])
  })
})

describe("toSubgoals", () => {
  it("assigns order, unique ids, and done=false", () => {
    const subs = toSubgoals(["a", "b", "c"])
    expect(subs.map((s) => s.order)).toEqual([0, 1, 2])
    expect(subs.every((s) => !s.done)).toBe(true)
    expect(new Set(subs.map((s) => s.id)).size).toBe(3)
  })
})

describe("markSubgoalsComplete", () => {
  const base: GoalSubgoal[] = [
    { id: "1", text: "a", done: false, order: 0 },
    { id: "2", text: "b", done: false, order: 1 },
    { id: "3", text: "c", done: true, order: 2 },
  ]

  it("marks the given indices done", () => {
    const next = markSubgoalsComplete(base, [0])
    expect(next[0].done).toBe(true)
    expect(next[1].done).toBe(false)
  })

  it("is monotonic — already-done steps stay done", () => {
    const next = markSubgoalsComplete(base, [0])
    expect(next[2].done).toBe(true)
  })

  it("ignores out-of-range indices", () => {
    expect(markSubgoalsComplete(base, [99])).toBe(base)
  })

  it("returns the same reference when nothing changes", () => {
    expect(markSubgoalsComplete(base, [2])).toBe(base) // index 2 already done
    expect(markSubgoalsComplete(base, [])).toBe(base)
    expect(markSubgoalsComplete([], [0])).toEqual([])
  })
})
