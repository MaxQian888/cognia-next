import type { Loop } from "@/types/loop"
import { clampLoopDelay, gateLoopContinuation } from "./pacing"

function buildLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "lp_1",
    sessionId: "ses_a",
    mode: "self_paced",
    rawPrompt: "x",
    safePrompt: "x",
    redactionMapEnc: "",
    isSlashCommand: false,
    status: "active",
    iterations: 1,
    tokensUsed: 0,
    generationId: "gen-1",
    config: {
      maxIterations: 100,
      maxTokens: 1_000_000,
      minDelayMs: 60_000,
      maxDelayMs: 3_600_000,
      maxParseFailures: 3,
    },
    parseFailureCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const NOW = 1_700_000_000_000

describe("clampLoopDelay", () => {
  it("clamps into [minDelayMs, maxDelayMs]", () => {
    const loop = buildLoop()
    expect(clampLoopDelay(loop, 5_000)).toBe(60_000)
    expect(clampLoopDelay(loop, 7_200_000)).toBe(3_600_000)
    expect(clampLoopDelay(loop, 300_000)).toBe(300_000)
  })

  it("falls back to the floor for missing/NaN values", () => {
    const loop = buildLoop()
    expect(clampLoopDelay(loop, undefined)).toBe(60_000)
    expect(clampLoopDelay(loop, Number.NaN)).toBe(60_000)
  })
})

describe("gateLoopContinuation", () => {
  it("sends immediately with no iteration baseline", () => {
    expect(gateLoopContinuation(buildLoop(), NOW)).toEqual({ kind: "send" })
  })

  it("defers until lastIterationAt + nextDelayMs", () => {
    const loop = buildLoop({ lastIterationAt: NOW - 60_000, nextDelayMs: 300_000 })
    expect(gateLoopContinuation(loop, NOW)).toEqual({
      kind: "defer",
      untilMs: NOW - 60_000 + 300_000,
    })
  })

  it("sends once the delay has elapsed", () => {
    const loop = buildLoop({ lastIterationAt: NOW - 400_000, nextDelayMs: 300_000 })
    expect(gateLoopContinuation(loop, NOW)).toEqual({ kind: "send" })
  })

  it("uses the floor delay when no suggestion was stored", () => {
    const loop = buildLoop({ lastIterationAt: NOW - 1_000 })
    expect(gateLoopContinuation(loop, NOW)).toEqual({
      kind: "defer",
      untilMs: NOW - 1_000 + 60_000,
    })
  })
})
