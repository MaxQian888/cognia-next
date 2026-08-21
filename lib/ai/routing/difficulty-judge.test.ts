import type { LlmClient } from "@/lib/twin/distill/llm"

import {
  __resetDifficultyJudgeCache,
  createDifficultyJudge,
  judgeDifficulty,
} from "./difficulty-judge"

function client(complete: (prompt: string, opts?: unknown) => Promise<string>): LlmClient {
  return { complete } as unknown as LlmClient
}

describe("judgeDifficulty", () => {
  beforeEach(__resetDifficultyJudgeCache)

  it("returns the tier the model named", async () => {
    const verdict = await judgeDifficulty(
      client(async () => '{"tier":"powerful","confidence":0.9}'),
      { promptText: "design a lock-free queue" }
    )
    expect(verdict).toEqual({ tier: "powerful", confidence: 0.9 })
  })

  it("never sends a prompt the redaction gate objects to", async () => {
    // A routing hint is not worth a disclosure, and the deterministic score
    // already answers — so the gate failing means "don't ask", not "ask anyway".
    const complete = jest.fn(async () => '{"tier":"fast"}')
    const verdict = await judgeDifficulty(client(complete), {
      promptText: "email dana@example.com and card 4111 1111 1111 1111",
    })
    expect(verdict).toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })

  it("returns null on a malformed answer rather than guessing", async () => {
    expect(
      await judgeDifficulty(
        client(async () => "it depends, honestly"),
        { promptText: "x y z" }
      )
    ).toBeNull()
    expect(
      await judgeDifficulty(
        client(async () => '{"tier":"medium"}'),
        { promptText: "a b c" }
      )
    ).toBeNull()
  })

  it("returns null when the model throws", async () => {
    const verdict = await judgeDifficulty(
      client(async () => {
        throw new Error("provider down")
      }),
      { promptText: "some prompt" }
    )
    expect(verdict).toBeNull()
  })

  it("gives up at the timeout and does NOT cache the give-up", async () => {
    // Caching a timeout would turn one slow moment into five minutes of a
    // disabled judge.
    let calls = 0
    const slow = client(async () => {
      calls += 1
      if (calls === 1) return new Promise<string>(() => {})
      return '{"tier":"balanced"}'
    })

    expect(await judgeDifficulty(slow, { promptText: "same prompt", timeoutMs: 5 })).toBeNull()
    expect(await judgeDifficulty(slow, { promptText: "same prompt", timeoutMs: 50 })).toEqual({
      tier: "balanced",
    })
    expect(calls).toBe(2)
  })

  it("caches a real verdict so a repeated prompt costs nothing", async () => {
    const complete = jest.fn(async () => '{"tier":"fast"}')
    const c = client(complete)
    await judgeDifficulty(c, { promptText: "repeat me" })
    await judgeDifficulty(c, { promptText: "repeat me" })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it("keys the cache by the heuristic's prior too", async () => {
    // The prior is in the prompt, so two different priors are two different
    // questions and must not share an answer.
    const complete = jest.fn(async () => '{"tier":"fast"}')
    const c = client(complete)
    await judgeDifficulty(c, { promptText: "same", deterministicTier: "fast" })
    await judgeDifficulty(c, { promptText: "same", deterministicTier: "powerful" })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it("asks for a correction rather than a fresh opinion", async () => {
    let seen = ""
    await judgeDifficulty(
      client(async (prompt) => {
        seen = prompt
        return '{"tier":"balanced"}'
      }),
      { promptText: "refactor the parser", deterministicTier: "balanced" }
    )
    expect(seen).toContain("A heuristic guessed: balanced")
    expect(seen).toContain("Correct it only if clearly wrong")
  })

  it("clamps a nonsense confidence instead of passing it through", async () => {
    const verdict = await judgeDifficulty(
      client(async () => '{"tier":"fast","confidence":42}'),
      { promptText: "clamp me" }
    )
    expect(verdict).toEqual({ tier: "fast", confidence: 1 })
  })
})

describe("createDifficultyJudge", () => {
  beforeEach(__resetDifficultyJudgeCache)

  it("returns null when the host has no utility client configured", async () => {
    const judge = createDifficultyJudge(() => null)
    expect(await judge({ promptText: "anything", deterministicTier: "fast" })).toBeNull()
  })

  it("passes the deterministic tier through as the prior", async () => {
    let seen = ""
    const judge = createDifficultyJudge(() =>
      client(async (prompt) => {
        seen = prompt
        return '{"tier":"powerful"}'
      })
    )
    expect(await judge({ promptText: "hard thing", deterministicTier: "balanced" })).toEqual({
      tier: "powerful",
    })
    expect(seen).toContain("balanced")
  })
})
