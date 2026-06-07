import type { Loop } from "@/types/loop"
import {
  LOOP_EXPIRY_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  buildLoopTaskInput,
  parseInterval,
} from "./interval"

describe("parseInterval", () => {
  it("parses minutes / hours / days", () => {
    expect(parseInterval("5m")).toBe(5 * 60_000)
    expect(parseInterval("2h")).toBe(2 * 3_600_000)
    expect(parseInterval("1d")).toBe(86_400_000)
  })

  it("rounds seconds UP to the one-minute floor", () => {
    expect(parseInterval("30s")).toBe(MIN_INTERVAL_MS)
    expect(parseInterval("90s")).toBe(90_000)
  })

  it("is case-insensitive and trims whitespace", () => {
    expect(parseInterval(" 5M ")).toBe(5 * 60_000)
  })

  it("rejects garbage, zero, and out-of-range tokens", () => {
    expect(parseInterval("soon")).toBeNull()
    expect(parseInterval("5x")).toBeNull()
    expect(parseInterval("0m")).toBeNull()
    expect(parseInterval("-5m")).toBeNull()
    expect(parseInterval("8d")).toBeNull()
    expect(parseInterval("5 m")).toBeNull()
    expect(parseInterval("")).toBeNull()
  })

  it("accepts the 7-day ceiling exactly", () => {
    expect(parseInterval("7d")).toBe(MAX_INTERVAL_MS)
  })
})

describe("buildLoopTaskInput", () => {
  const loop: Loop = {
    id: "lp_1",
    sessionId: "ses_a",
    mode: "interval",
    rawPrompt: "check the deploy status and report anomalies",
    safePrompt: "check the deploy status and report anomalies",
    redactionMapEnc: "",
    isSlashCommand: false,
    status: "active",
    iterations: 0,
    tokensUsed: 0,
    generationId: "gen-1",
    config: {
      maxIterations: 42,
      maxTokens: 1_000_000,
      minDelayMs: 60_000,
      maxDelayMs: 3_600_000,
      maxParseFailures: 3,
    },
    parseFailureCount: 0,
    intervalMs: 5 * 60_000,
    expiresAt: 1_700_000_000_000 + LOOP_EXPIRY_MS,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }

  it("maps the loop onto a chat task with skip-overlap and no catch-up", () => {
    const input = buildLoopTaskInput(loop)
    expect(input.type).toBe("chat")
    expect(input.trigger).toEqual({ type: "interval", intervalMs: 5 * 60_000 })
    expect(input.payload).toEqual({
      prompt: "check the deploy status and report anomalies",
      sessionId: "ses_a",
    })
    expect(input.config?.overlapPolicy).toBe("skip")
    expect(input.config?.runMissedOnStartup).toBe(false)
    expect(input.config?.maxRuns).toBe(42)
    expect(input.tags).toEqual(["loop"])
    expect(input.endAt?.getTime()).toBe(loop.expiresAt)
  })

  it("truncates long prompts in the task name", () => {
    const long = { ...loop, rawPrompt: "x".repeat(100) }
    const input = buildLoopTaskInput(long)
    expect(input.name.length).toBeLessThanOrEqual("Loop: ".length + 60)
    expect(input.name.endsWith("…")).toBe(true)
  })

  it("uses the safe (redacted) prompt for the payload, never the raw one", () => {
    const redacted = { ...loop, rawPrompt: "email bob@x.com", safePrompt: "email <EMAIL_001>" }
    const input = buildLoopTaskInput(redacted)
    expect((input.payload as { prompt: string }).prompt).toBe("email <EMAIL_001>")
  })
})
