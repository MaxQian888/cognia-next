import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"

import { diagnoseAgentEvent } from "./from-agent-event"

const envelope = (overrides: Record<string, unknown> = {}) =>
  ({
    schemaVersion: 1,
    eventId: "e1",
    sequence: 1,
    sessionId: "sess-1",
    timestamp: 0,
    event: { kind: "text-delta", delta: "" },
    ...overrides,
  }) as unknown as AgentEventEnvelope

describe("diagnoseAgentEvent", () => {
  it("lifts a structured failure without touching its message", () => {
    const event: CanonicalAgentEvent = {
      kind: "failure",
      code: "rateLimited",
      message: "429 Too Many Requests",
      retryable: true,
    }
    expect(diagnoseAgentEvent(event)).toEqual({
      code: "rateLimited",
      severity: "error",
      message: "429 Too Many Requests",
      retryable: true,
      meta: {},
    })
  })

  it("degrades a runtime code the registry doesn't know", () => {
    // Codes cross a process boundary from the agent host; a newer runtime must
    // not produce a label with no translation behind it.
    const event: CanonicalAgentEvent = {
      kind: "failure",
      code: "some_future_runtime_code",
      message: "m",
    }
    expect(diagnoseAgentEvent(event)?.code).toBe("unknown")
  })

  it("omits retryable when the event did not state one", () => {
    const out = diagnoseAgentEvent({ kind: "failure", code: "timeout", message: "m" })
    expect(out && "retryable" in out).toBe(false)
  })

  it("downgrades a warning event to warning severity", () => {
    expect(
      diagnoseAgentEvent({ kind: "warning", code: "degradedFallback", message: "m" })?.severity
    ).toBe("warning")
  })

  it("degrades an unknown warning code too, not just an unknown failure code", () => {
    const out = diagnoseAgentEvent({ kind: "warning", code: "future_warning", message: "m" })
    expect(out).toEqual({ code: "unknown", severity: "warning", message: "m", meta: {} })
  })

  it("describes a capability error including the command that needed it", () => {
    const out = diagnoseAgentEvent({
      kind: "capability-error",
      capability: "streaming" as never,
      command: "claude_send",
    })
    expect(out?.code).toBe("capabilityUnsatisfied")
    expect(out?.message).toContain("claude_send")
    expect(out?.meta.extra).toEqual({ capability: "streaming" })
  })

  it("describes a capability error with no command", () => {
    const out = diagnoseAgentEvent({ kind: "capability-error", capability: "tools" as never })
    expect(out?.message).toBe("tools is not supported by this runtime")
  })

  it("keeps the envelope's correlation ids so a report can name the exact turn", () => {
    const out = diagnoseAgentEvent(
      { kind: "failure", code: "timeout", message: "m" },
      envelope({ runId: "run-1", turnId: "turn-2", attemptId: "att-3" })
    )
    expect(out?.meta).toEqual({
      sessionId: "sess-1",
      runId: "run-1",
      turnId: "turn-2",
      extra: { attemptId: "att-3" },
    })
  })

  it("returns null for the ordinary stream so callers need no pre-filter", () => {
    const benign: CanonicalAgentEvent[] = [
      { kind: "text-delta", delta: "hi" },
      { kind: "thinking-delta", delta: "…" },
      { kind: "lifecycle", phase: "started" },
      { kind: "usage", usage: {} },
      { kind: "checkpoint", checkpointId: "c1" },
    ]
    for (const event of benign) {
      expect(diagnoseAgentEvent(event)).toBeNull()
    }
  })
})
