import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"

// The Router + Fusion gate reads the settings through this seam. `null` is what
// every user has by default — the switch off — so every test below the
// Router + Fusion block runs the judge exactly as it always ran.
const mockGateSettings = jest.fn<Promise<AppSettings | null>, []>(async () => null)
jest.mock("@/lib/router-fusion/gate/current-settings", () => ({
  currentRouterFusionGateSettings: () => mockGateSettings(),
}))
// The classifier is loaded only behind the gate; the counter proves it.
const mockClassifierLoads = jest.fn()
const mockJudgeWithClassifier = jest.fn()
const mockClassifierImport = { fail: false }
jest.mock("@/lib/router-fusion/routing/llm-classifier", () => {
  mockClassifierLoads()
  if (mockClassifierImport.fail) throw new Error("chunk load failed")
  return {
    judgeDifficultyWithClassifier: (...args: unknown[]) => mockJudgeWithClassifier(...args),
  }
})

import { __resetBreakerForTesting, getBreakerSnapshot } from "@/lib/router-fusion/gate/breaker"

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

  it("honours a custom cache TTL instead of the five-minute default", async () => {
    let at = 1_000
    const complete = jest.fn(async () => '{"tier":"fast"}')
    const c = client(complete)
    const now = () => at
    await judgeDifficulty(c, { promptText: "ttl", cacheTtlMs: 100, now })
    at += 50
    await judgeDifficulty(c, { promptText: "ttl", cacheTtlMs: 100, now })
    expect(complete).toHaveBeenCalledTimes(1)
    at += 60 // 110 ms in — past the custom TTL, inside the default
    await judgeDifficulty(c, { promptText: "ttl", cacheTtlMs: 100, now })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it("disables the cache entirely when cacheTtlMs is 0 — no reads, no writes", async () => {
    let at = 1_000
    const complete = jest.fn(async () => '{"tier":"fast"}')
    const c = client(complete)
    const now = () => at
    // Long TTL: the entry is provably fresh for the zero-TTL call below.
    await judgeDifficulty(c, { promptText: "never cached", cacheTtlMs: 1_000, now })
    at = 1_100
    // A cacheTtlMs of 0 must not read the verdict the first call wrote.
    await judgeDifficulty(c, { promptText: "never cached", cacheTtlMs: 0, now })
    expect(complete).toHaveBeenCalledTimes(2)
    at = 1_150
    // Nor write: this call's TTL (60 ms) has expired the FIRST entry
    // (1_150 − 1_000 > 60) while a hypothetical write at 1_100 would still be
    // fresh — so a miss here proves the zero-TTL call stored nothing.
    await judgeDifficulty(c, { promptText: "never cached", cacheTtlMs: 60, now })
    expect(complete).toHaveBeenCalledTimes(3)
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

  it("carries the caller's cacheTtlMs through to judgeDifficulty", async () => {
    const complete = jest.fn(async () => '{"tier":"fast"}')
    const judge = createDifficultyJudge(() => client(complete), { cacheTtlMs: 0 })
    await judge({ promptText: "bound prompt", deterministicTier: "fast" })
    await judge({ promptText: "bound prompt", deterministicTier: "fast" })
    expect(complete).toHaveBeenCalledTimes(2)
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

// ── Router + Fusion: the LLM classifier absorbs the judge (ADR-0188 D18) ──────

function fusionSettings(
  overrides: { enabled?: unknown; utilityLedger?: unknown; classifier?: unknown } = {}
): AppSettings {
  return {
    routerFusion: {
      enabled: overrides.enabled ?? true,
      surfaces: { utilityLedger: overrides.utilityLedger ?? true },
      llmClassifier: {
        enabled: overrides.classifier ?? true,
        timeoutMs: 1500,
        cacheTtlSeconds: 600,
      },
    },
  } as unknown as AppSettings
}

describe("judgeDifficulty — Router + Fusion off (off-path parity)", () => {
  beforeEach(() => {
    __resetDifficultyJudgeCache()
    __resetBreakerForTesting()
    mockGateSettings.mockReset()
    mockClassifierLoads.mockClear()
    mockJudgeWithClassifier.mockReset()
  })

  it("[ACC:OFF-02] judges exactly as before, with nothing of Router + Fusion loaded, whatever else is set", async () => {
    const offs: Array<AppSettings | null> = [
      null,
      fusionSettings({ enabled: false }),
      fusionSettings({ utilityLedger: false }),
      fusionSettings({ classifier: false }),
      fusionSettings({ classifier: "true" }),
      {} as AppSettings,
    ]
    for (const settings of offs) {
      __resetDifficultyJudgeCache()
      mockGateSettings.mockResolvedValue(settings)
      const prompts: unknown[] = []
      const verdict = await judgeDifficulty(
        client(async (prompt, opts) => {
          prompts.push([prompt, opts])
          return '{"tier":"powerful","confidence":0.7}'
        }),
        { promptText: "  refactor the parser  ", deterministicTier: "balanced" }
      )
      // The same verdict, from the same request, as the judge has always made.
      expect(verdict).toEqual({ tier: "powerful", confidence: 0.7 })
      expect(prompts).toEqual([
        [
          "Request:\nrefactor the parser\nA heuristic guessed: balanced. Correct it only if clearly wrong.",
          expect.objectContaining({ temperature: 0, maxTokens: 24 }),
        ],
      ])
    }
    expect(mockClassifierLoads).not.toHaveBeenCalled()
    expect(mockJudgeWithClassifier).not.toHaveBeenCalled()
  })

  it("runs the judge as before when the settings cannot be read", async () => {
    mockGateSettings.mockRejectedValue(new Error("store unavailable"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const complete = jest.fn(async () => '{"tier":"fast"}')
    expect(await judgeDifficulty(client(complete), { promptText: "unreadable" })).toEqual({
      tier: "fast",
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(mockClassifierLoads).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("judgeDifficulty — absorbed by the LLM classifier", () => {
  beforeEach(() => {
    __resetDifficultyJudgeCache()
    __resetBreakerForTesting()
    mockGateSettings.mockReset()
    mockJudgeWithClassifier.mockReset()
  })

  it("answers with the classifier when utilityLedger is on and the classifier enabled", async () => {
    const settings = fusionSettings()
    mockGateSettings.mockResolvedValue(settings)
    mockJudgeWithClassifier.mockResolvedValue({ tier: "powerful" })
    const complete = jest.fn(async () => '{"tier":"fast"}')
    expect(
      await judgeDifficulty(client(complete), {
        promptText: "design a lock-free queue",
        deterministicTier: "balanced",
      })
    ).toEqual({ tier: "powerful" })
    // The judge's own model is never asked: one classification replaces it.
    expect(complete).not.toHaveBeenCalled()
    expect(mockJudgeWithClassifier).toHaveBeenCalledWith(settings, {
      promptText: "design a lock-free queue",
    })
    expect(getBreakerSnapshot("utilityLedger").consecutiveFaults).toBe(0)
  })

  it("keeps the deterministic tier when the classifier falls back, without a second opinion", async () => {
    mockGateSettings.mockResolvedValue(fusionSettings())
    mockJudgeWithClassifier.mockResolvedValue(null)
    const complete = jest.fn(async () => '{"tier":"fast"}')
    expect(await judgeDifficulty(client(complete), { promptText: "anything" })).toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })

  it("delegates the same way through createDifficultyJudge", async () => {
    mockGateSettings.mockResolvedValue(fusionSettings())
    mockJudgeWithClassifier.mockResolvedValue({ tier: "fast" })
    const judge = createDifficultyJudge(() => client(async () => '{"tier":"powerful"}'))
    expect(await judge({ promptText: "short", deterministicTier: "balanced" })).toEqual({
      tier: "fast",
    })
  })

  it("[ACC:ISO-01] falls back to the original judge, unledgered, on an infrastructure fault, and counts it", async () => {
    mockGateSettings.mockResolvedValue(fusionSettings())
    mockJudgeWithClassifier.mockRejectedValue(new Error("classifier exploded"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const complete = jest.fn(async () => '{"tier":"balanced"}')
    expect(await judgeDifficulty(client(complete), { promptText: "fault" })).toEqual({
      tier: "balanced",
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(getBreakerSnapshot("utilityLedger").consecutiveFaults).toBe(1)
    warn.mockRestore()
  })

  it("runs the original judge while the utilityLedger surface is tripped", async () => {
    mockGateSettings.mockResolvedValue({
      routerFusion: {
        ...(fusionSettings().routerFusion as object),
        trippedSurfaces: { utilityLedger: { trippedAt: 1, reason: "db_unavailable" } },
      },
    } as unknown as AppSettings)
    const complete = jest.fn(async () => '{"tier":"fast"}')
    expect(await judgeDifficulty(client(complete), { promptText: "tripped" })).toEqual({
      tier: "fast",
    })
    expect(mockJudgeWithClassifier).not.toHaveBeenCalled()
  })

  it("reports a classifier that fails to load as an import fault and judges on the original path", async () => {
    // Forget every loaded module so the classifier's (mocked) chunk is loaded
    // anew — and fails. The judge and breaker imported above keep their
    // instances, which is what production has: the judge is loaded, the chunk
    // behind the gate is not.
    jest.resetModules()
    mockClassifierImport.fail = true
    try {
      mockGateSettings.mockResolvedValue(fusionSettings())
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      const complete = jest.fn(async () => '{"tier":"powerful"}')
      expect(await judgeDifficulty(client(complete), { promptText: "load" })).toEqual({
        tier: "powerful",
      })
      expect(complete).toHaveBeenCalledTimes(1)
      expect(mockJudgeWithClassifier).not.toHaveBeenCalled()
      expect(getBreakerSnapshot("utilityLedger")).toMatchObject({ consecutiveFaults: 1 })
      expect(warn).toHaveBeenCalledWith(
        "[router-fusion] the difficulty judge ran on the original path, unledgered",
        expect.objectContaining({ code: "import_failed" })
      )
      warn.mockRestore()
    } finally {
      mockClassifierImport.fail = false
    }
  })
})
