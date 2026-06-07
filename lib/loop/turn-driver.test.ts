import "fake-indexeddb/auto"
import type { LoopCreateInput } from "@/lib/db/loops"
import { createLoop, getLoop, listLoopEvents, updateLoop } from "@/lib/db/loops"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { handleLoopTurnComplete } from "./turn-driver"

const NOW = 1_700_000_000_000

function buildLoop(overrides: Partial<LoopCreateInput> = {}): LoopCreateInput {
  return {
    id: overrides.id ?? "lp_1",
    sessionId: overrides.sessionId ?? "ses_a",
    mode: "self_paced",
    rawPrompt: overrides.rawPrompt ?? "summarize progress",
    safePrompt: overrides.safePrompt ?? "summarize progress",
    redactionMapEnc: "",
    isSlashCommand: false,
    status: overrides.status ?? "active",
    iterations: overrides.iterations ?? 0,
    tokensUsed: overrides.tokensUsed ?? 0,
    generationId: overrides.generationId ?? "gen-1",
    config: overrides.config ?? {
      maxIterations: 100,
      maxTokens: 1_000_000,
      minDelayMs: 60_000,
      maxDelayMs: 3_600_000,
      maxParseFailures: 3,
    },
    parseFailureCount: overrides.parseFailureCount ?? 0,
    expiresAt: overrides.expiresAt ?? NOW + 7 * 86_400_000,
  }
}

const CONTINUE_TRAILER = '{"continue": true, "delaySeconds": 300, "reason": "build running"}'

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("handleLoopTurnComplete — basic outcomes", () => {
  it("returns no_loop for an unknown id", async () => {
    const out = await handleLoopTurnComplete({
      loopId: "missing",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("no_loop")
  })

  it("returns stale when the generation rotated", async () => {
    await createLoop(buildLoop())
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 0,
      capturedGenerationId: "outdated",
      nowMs: NOW,
    })
    expect(out.kind).toBe("stale")
  })

  it("returns stale when the loop is not active", async () => {
    await createLoop(buildLoop({ status: "paused" }))
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("stale")
  })

  it("returns aborted when the signal already fired", async () => {
    await createLoop(buildLoop())
    const ac = new AbortController()
    ac.abort()
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      signal: ac.signal,
      nowMs: NOW,
    })
    expect(out.kind).toBe("aborted")
  })
})

describe("handleLoopTurnComplete — iteration persistence + continue", () => {
  it("bumps iterations/tokens, stores the clamped delay, and returns continue", async () => {
    await createLoop(buildLoop({ iterations: 2, tokensUsed: 100 }))
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: `did the thing\n${CONTINUE_TRAILER}`,
      tokensDelta: 500,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("continue")
    if (out.kind !== "continue") return
    expect(out.delayMs).toBe(300_000)
    expect(out.reason).toBe("build running")
    expect(out.userMessage).toContain("[Loop iteration 4 of 100]")
    const loop = await getLoop("lp_1")
    expect(loop?.iterations).toBe(3)
    expect(loop?.tokensUsed).toBe(600)
    expect(loop?.nextDelayMs).toBe(300_000)
    expect(loop?.nextDelayReason).toBe("build running")
    expect(loop?.lastIterationAt).toBe(NOW)
    expect(loop?.parseFailureCount).toBe(0)
    const events = await listLoopEvents("lp_1")
    expect(events.some((e) => e.kind === "iteration_completed")).toBe(true)
    expect(events.some((e) => e.kind === "delay_decided")).toBe(true)
  })

  it("clamps an out-of-bounds suggested delay", async () => {
    await createLoop(buildLoop())
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: '{"continue": true, "delaySeconds": 7200}',
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("continue")
    if (out.kind !== "continue") return
    expect(out.delayMs).toBe(3_600_000)
  })
})

describe("handleLoopTurnComplete — exits", () => {
  it("iteration_limited fires at the cap", async () => {
    await createLoop(
      buildLoop({
        iterations: 4,
        config: {
          maxIterations: 5,
          maxTokens: 1_000_000,
          minDelayMs: 60_000,
          maxDelayMs: 3_600_000,
          maxParseFailures: 3,
        },
      })
    )
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("iteration_limited")
    expect((await getLoop("lp_1"))?.status).toBe("iteration_limited")
    expect((await getLoop("lp_1"))?.endedAt).toBeGreaterThan(0)
  })

  it("budget_limited fires when tokens cross the cap", async () => {
    await createLoop(
      buildLoop({
        tokensUsed: 999_900,
        config: {
          maxIterations: 100,
          maxTokens: 1_000_000,
          minDelayMs: 60_000,
          maxDelayMs: 3_600_000,
          maxParseFailures: 3,
        },
      })
    )
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 200,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("budget_limited")
  })

  it("expired fires past the hard expiry", async () => {
    await createLoop(buildLoop({ expiresAt: NOW - 1 }))
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("expired")
  })

  it("completed fires on a continue:false trailer", async () => {
    await createLoop(buildLoop())
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: '{"continue": false, "reason": "report delivered"}',
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("completed")
    expect(out.reason).toBe("report delivered")
    expect((await getLoop("lp_1"))?.status).toBe("completed")
  })
})

describe("handleLoopTurnComplete — trailer parse failures (fail-OPEN)", () => {
  it("first failure continues at the floor delay and bumps the counter", async () => {
    await createLoop(buildLoop())
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: "no trailer here",
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("continue")
    if (out.kind !== "continue") return
    expect(out.delayMs).toBe(60_000)
    const loop = await getLoop("lp_1")
    expect(loop?.parseFailureCount).toBe(1)
    expect((await listLoopEvents("lp_1")).some((e) => e.kind === "delay_parse_failed")).toBe(true)
  })

  it("exits as error at maxParseFailures", async () => {
    await createLoop(buildLoop({ parseFailureCount: 2 }))
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: "still no trailer",
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("exit")
    if (out.kind !== "exit") return
    expect(out.exit).toBe("parse_failed_too_many")
    expect((await getLoop("lp_1"))?.status).toBe("error")
  })

  it("a successful trailer resets the failure counter", async () => {
    await createLoop(buildLoop({ parseFailureCount: 2 }))
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("continue")
    expect((await getLoop("lp_1"))?.parseFailureCount).toBe(0)
  })
})

describe("handleLoopTurnComplete — race guard through awaits", () => {
  it("bails stale when the generation rotates mid-flight", async () => {
    await createLoop(buildLoop())
    // Rotate the generation between Step 1's persist and the re-read by
    // patching the row first (simulates a concurrent pause).
    await updateLoop("lp_1", { generationId: "rotated" })
    const out = await handleLoopTurnComplete({
      loopId: "lp_1",
      lastResponse: CONTINUE_TRAILER,
      tokensDelta: 0,
      capturedGenerationId: "gen-1",
      nowMs: NOW,
    })
    expect(out.kind).toBe("stale")
  })
})
