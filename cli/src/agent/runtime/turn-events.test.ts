import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import { createSideEffectTracker } from "./retry"
import {
  canonicalFromCapture,
  createEnvelopeEmitter,
  mintAttemptId,
  mintRunId,
  mintTurnId,
  sideEffectReason,
  type TurnIdentity,
} from "./turn-events"

const identity: TurnIdentity = {
  sessionId: "s1",
  runId: "run_1",
  turnId: "run_1:t0",
  attemptId: "run_1:t0:a0",
  hostRef: "headless-agent-host",
  runtime: "claude-agent-sdk",
}

function emitter(overrides: Partial<Parameters<typeof createEnvelopeEmitter>[0]> = {}) {
  return createEnvelopeEmitter({
    identity,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  })
}

describe("canonicalFromCapture", () => {
  it("preserves tool summaries when diagnostics are disabled", () => {
    const event = {
      type: "tool-summary",
      summary: "Read the project",
      toolCallIds: ["call-1"],
    } as const
    expect(emitter().fromCapture({ ...event, toolCallIds: [...event.toolCallIds] })?.event).toEqual(
      { kind: "tool-summary", summary: event.summary, toolCallIds: ["call-1"] }
    )
  })

  it("maps a retry to the canonical kind, not to a suppressed diagnostic", () => {
    // The `default` branch turns unknown capture events into `diagnostic`,
    // which `fromCapture` drops unless `includeDiagnostics` is on — so a
    // missing case here is indistinguishable from the retry never happening.
    expect(
      canonicalFromCapture({
        type: "retry",
        phase: "scheduled",
        attempt: 2,
        maxRetries: 10,
        code: "api_retry",
        delayMs: 1_089,
        message: "unknown",
      })
    ).toEqual({
      kind: "retry",
      phase: "scheduled",
      attempt: 2,
      maxRetries: 10,
      code: "api_retry",
      delayMs: 1_089,
      message: "unknown",
    })
  })

  it("maps the text-ish deltas", () => {
    expect(canonicalFromCapture({ type: "text-delta", delta: "hi" })).toEqual({
      kind: "text-delta",
      delta: "hi",
    })
    expect(canonicalFromCapture({ type: "thinking-delta", delta: "hmm" })).toEqual({
      kind: "thinking-delta",
      delta: "hmm",
    })
    expect(
      canonicalFromCapture({
        type: "commentary-delta",
        delta: "checking",
        messageId: "c1",
        done: false,
      })
    ).toEqual({ kind: "commentary-delta", delta: "checking", messageId: "c1", done: false })
  })

  it("treats an absent delta as empty rather than undefined", () => {
    expect(canonicalFromCapture({ type: "text-delta" } as CaptureStreamEvent)).toEqual({
      kind: "text-delta",
      delta: "",
    })
  })

  it("maps tool calls and results, preserving ids and error flags", () => {
    expect(
      canonicalFromCapture({
        type: "tool-call",
        toolName: "Bash",
        input: { command: "ls" },
        id: "c1",
      })
    ).toEqual({ kind: "tool-call", toolName: "Bash", input: { command: "ls" }, toolCallId: "c1" })

    expect(
      canonicalFromCapture({
        type: "tool-result",
        toolName: "Bash",
        id: "c1",
        result: "ok",
        isError: true,
      })
    ).toEqual({
      kind: "tool-result",
      toolName: "Bash",
      toolCallId: "c1",
      result: "ok",
      isError: true,
    })
  })

  it("defaults a tool call with no input to an empty object", () => {
    // `CaptureStreamEvent` declares `input` as required, so this payload is
    // deliberately type-violating: it is what an SDK that omits the field
    // actually delivers, and the `?? {}` in `canonicalFromCapture` is the
    // guard against it. Widening the union instead would push the same
    // `undefined` onto every consumer.
    const malformed = { type: "tool-call", toolName: "Read" } as unknown as CaptureStreamEvent

    expect(canonicalFromCapture(malformed)).toMatchObject({ input: {} })
  })

  it("maps usage and compaction", () => {
    expect(
      canonicalFromCapture({
        type: "usage",
        usage: { inputTokens: 5 },
        partial: true,
      } as CaptureStreamEvent)
    ).toEqual({ kind: "usage", usage: { inputTokens: 5 }, partial: true })

    expect(
      canonicalFromCapture({ type: "compact", trigger: "manual", preTokens: 10, postTokens: 2 })
    ).toEqual({ kind: "compact", trigger: "manual", preTokens: 10, postTokens: 2 })
    expect(
      canonicalFromCapture({ type: "compact", trigger: "auto", preTokens: 0, postTokens: 0 })
    ).toMatchObject({ trigger: "auto" })
  })

  it("omits every optional field the capture event did not carry", () => {
    expect(canonicalFromCapture({ type: "commentary-delta", delta: "x" })).toEqual({
      kind: "commentary-delta",
      delta: "x",
    })
    expect(canonicalFromCapture({ type: "tool-call", toolName: "Read", input: {} })).toEqual({
      kind: "tool-call",
      toolName: "Read",
      input: {},
    })
    expect(canonicalFromCapture({ type: "tool-result", toolName: "Read", result: "x" })).toEqual({
      kind: "tool-result",
      toolName: "Read",
      result: "x",
    })
    expect(canonicalFromCapture({ type: "usage", usage: {} } as CaptureStreamEvent)).toEqual({
      kind: "usage",
      usage: {},
    })
  })

  it("keeps a tool result's echoed input when the capture layer supplied one", () => {
    expect(
      canonicalFromCapture({
        type: "tool-result",
        toolName: "Read",
        input: { path: "a" },
        result: "x",
        isError: false,
      })
    ).toEqual({
      kind: "tool-result",
      toolName: "Read",
      input: { path: "a" },
      result: "x",
    })
  })

  it("omits absent compaction token counts and defaults absent usage to empty", () => {
    expect(
      canonicalFromCapture({ type: "compact", trigger: "auto" } as CaptureStreamEvent)
    ).toEqual({ kind: "compact", trigger: "auto" })
    expect(canonicalFromCapture({ type: "usage" } as CaptureStreamEvent)).toEqual({
      kind: "usage",
      usage: {},
    })
  })

  it("turns an unknown event into a diagnostic rather than dropping it", () => {
    const unknown = { type: "quantum-flux", payload: 1 } as unknown as CaptureStreamEvent
    expect(canonicalFromCapture(unknown)).toEqual({
      kind: "diagnostic",
      runtime: "capture",
      payload: unknown,
    })
  })
})

describe("sideEffectReason", () => {
  it("counts emitted text, tool calls, tool results and compaction", () => {
    expect(sideEffectReason({ kind: "text-delta", delta: "x" })).toContain("assistant text")
    expect(sideEffectReason({ kind: "tool-call", toolName: "Bash", input: {} })).toContain("Bash")
    expect(sideEffectReason({ kind: "tool-result", toolName: "Bash", result: "" })).toContain(
      "Bash"
    )
    expect(sideEffectReason({ kind: "compact", trigger: "auto" })).toContain("compacted")
  })

  it("does not count an empty text delta, thinking, or usage", () => {
    expect(sideEffectReason({ kind: "text-delta", delta: "" })).toBeNull()
    expect(sideEffectReason({ kind: "thinking-delta", delta: "private" })).toBeNull()
    expect(sideEffectReason({ kind: "usage", usage: {} })).toBeNull()
    expect(sideEffectReason({ kind: "lifecycle", phase: "started" })).toBeNull()
  })

  it("does not count a retry — it happens before any output", () => {
    // A retry that marked the turn unreplayable would defeat the retry policy
    // itself: `decideRetry` refuses to replay once a side effect is recorded.
    expect(
      sideEffectReason({
        kind: "retry",
        phase: "scheduled",
        attempt: 1,
        maxRetries: 10,
        code: "api_retry",
      })
    ).toBeNull()
  })
})

describe("createEnvelopeEmitter", () => {
  it("stamps schemaVersion, identity and a monotonic sequence", () => {
    const emit = emitter()
    const first = emit.emit({ kind: "lifecycle", phase: "started" })
    const second = emit.emit({ kind: "text-delta", delta: "hi" })

    expect(first).toMatchObject({
      schemaVersion: 1,
      eventId: "s1:run_1:t0:run_1:t0:a0:0",
      sequence: 0,
      sessionId: "s1",
      runId: "run_1",
      turnId: "run_1:t0",
      attemptId: "run_1:t0:a0",
      hostRef: "headless-agent-host",
      runtime: "claude-agent-sdk",
      timestamp: "2026-01-01T00:00:00.000Z",
    })
    expect(second.sequence).toBe(1)
    expect(emit.sequence).toBe(2)
    expect(emit.emitted).toHaveLength(2)
  })

  it("includes the optional identity fields only when present", () => {
    const bare = emitter().emit({ kind: "lifecycle", phase: "started" })
    expect(bare.providerAttemptId).toBeUndefined()
    expect(bare.parentRunId).toBeUndefined()

    const rich = createEnvelopeEmitter({
      identity: { ...identity, providerAttemptId: "pa1", parentRunId: "root" },
    }).emit({ kind: "lifecycle", phase: "started" })
    expect(rich).toMatchObject({ providerAttemptId: "pa1", parentRunId: "root" })
  })

  it("delivers every envelope to the subscriber in order", () => {
    const seen: number[] = []
    const emit = emitter({ onEnvelope: (e) => seen.push(e.sequence) })
    emit.emit({ kind: "lifecycle", phase: "started" })
    emit.emit({ kind: "lifecycle", phase: "ended" })
    expect(seen).toEqual([0, 1])
  })

  it("marks the side-effect tracker as it forwards, so call sites cannot forget", () => {
    const sideEffects = createSideEffectTracker()
    const emit = emitter({ sideEffects })
    emit.fromCapture({ type: "thinking-delta", delta: "planning" })
    expect(sideEffects.performed).toBe(false)

    emit.fromCapture({ type: "text-delta", delta: "answer" })
    expect(sideEffects.performed).toBe(true)
    expect(sideEffects.reason).toContain("assistant text")
  })

  it("marks a tool call even when no text was ever emitted", () => {
    const sideEffects = createSideEffectTracker()
    emitter({ sideEffects }).fromCapture({ type: "tool-call", toolName: "Write", input: {} })
    expect(sideEffects.reason).toContain("Write")
  })

  it("suppresses diagnostics by default and emits them when opted in", () => {
    const unknown = { type: "quantum-flux" } as unknown as CaptureStreamEvent
    const off = emitter()
    expect(off.fromCapture(unknown)).toBeNull()
    expect(off.emitted).toHaveLength(0)
    // A suppressed event must not consume a sequence number either.
    expect(off.sequence).toBe(0)

    const on = emitter({ includeDiagnostics: true })
    expect(on.fromCapture(unknown)?.event.kind).toBe("diagnostic")
  })

  it("still emits ordinary events when diagnostics are suppressed", () => {
    const emit = emitter()
    expect(emit.fromCapture({ type: "text-delta", delta: "hi" })?.event).toEqual({
      kind: "text-delta",
      delta: "hi",
    })
  })
})

describe("id minting", () => {
  it("mints greppable, distinctly-prefixed run ids", () => {
    expect(mintRunId(1_000_000, 0.5)).toMatch(/^run_/)
    expect(mintRunId(1_000_000, 0.5)).not.toBe(mintRunId(2_000_000, 0.5))
  })

  it("scopes turn ids to their run and attempt ids to their turn", () => {
    const runId = "run_abc"
    const turnId = mintTurnId(runId, 3)
    expect(turnId).toBe("run_abc:t3")
    expect(mintAttemptId(turnId, 2)).toBe("run_abc:t3:a2")
  })

  it("gives every retry a distinct attempt id", () => {
    const turnId = mintTurnId("run_abc", 0)
    const ids = [0, 1, 2].map((n) => mintAttemptId(turnId, n))
    expect(new Set(ids).size).toBe(3)
  })
})
