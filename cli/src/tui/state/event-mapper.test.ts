/**
 * @jest-environment node
 */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import {
  CANONICAL_TUI_CLASSIFICATION,
  captureEventToActions,
  canonicalEnvelopeToActions,
  classifyCanonicalEvent,
  toolCallKey,
} from "./event-mapper"
import {
  CANONICAL_AGENT_EVENT_KINDS,
  type AgentEventEnvelope,
  type CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"

describe("toolCallKey", () => {
  it("combines tool name and serialized input", () => {
    expect(toolCallKey("bash", { command: "ls" })).toBe('bash:{"command":"ls"}')
  })

  it("tolerates non-serializable input", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(toolCallKey("x", circular)).toBe("x:")
  })
})

describe("captureEventToActions", () => {
  it("maps text-delta", () => {
    expect(captureEventToActions({ type: "text-delta", delta: "hi" })).toEqual([
      { type: "INFLIGHT_TEXT", delta: "hi" },
    ])
  })

  it("drops empty text-delta", () => {
    expect(captureEventToActions({ type: "text-delta", delta: "" })).toEqual([])
  })

  it("maps thinking-delta", () => {
    expect(captureEventToActions({ type: "thinking-delta", delta: "hmm" })).toEqual([
      { type: "INFLIGHT_THINKING", delta: "hmm" },
    ])
  })

  it("drops empty thinking-delta", () => {
    expect(captureEventToActions({ type: "thinking-delta", delta: "" })).toEqual([])
  })

  it("maps tool-call with a correlation key", () => {
    const actions = captureEventToActions({
      type: "tool-call",
      toolName: "bash",
      input: { command: "ls" },
    })
    expect(actions).toEqual([
      {
        type: "TOOL_CALL",
        callKey: 'bash:{"command":"ls"}',
        toolName: "bash",
        input: { command: "ls" },
      },
    ])
  })

  it("prefers the tool_use id as the correlation key when present", () => {
    const actions = captureEventToActions({
      type: "tool-call",
      toolName: "bash",
      input: { command: "ls" },
      id: "tu_42",
    })
    expect(actions).toEqual([
      { type: "TOOL_CALL", callKey: "tu_42", toolName: "bash", input: { command: "ls" } },
    ])
  })

  it("gives two identical concurrent calls distinct keys via their ids", () => {
    const a = captureEventToActions({
      type: "tool-call",
      toolName: "read",
      input: { p: "x" },
      id: "tu_1",
    })
    const b = captureEventToActions({
      type: "tool-call",
      toolName: "read",
      input: { p: "x" },
      id: "tu_2",
    })
    expect((a[0] as { callKey: string }).callKey).toBe("tu_1")
    expect((b[0] as { callKey: string }).callKey).toBe("tu_2")
  })

  it("maps an ExitPlanMode tool-call with its plan input intact (the reducer's plan signal)", () => {
    const actions = captureEventToActions({
      type: "tool-call",
      toolName: "ExitPlanMode",
      input: { plan: "# Plan\n- step one" },
    })
    expect(actions).toEqual([
      {
        type: "TOOL_CALL",
        callKey: 'ExitPlanMode:{"plan":"# Plan\\n- step one"}',
        toolName: "ExitPlanMode",
        input: { plan: "# Plan\n- step one" },
      },
    ])
  })

  it("maps tool-result with input and error flag", () => {
    expect(
      captureEventToActions({
        type: "tool-result",
        toolName: "bash",
        input: { command: "ls" },
        result: "ok",
        isError: true,
      })
    ).toEqual([
      {
        type: "TOOL_RESULT",
        toolName: "bash",
        input: { command: "ls" },
        callKey: 'bash:{"command":"ls"}',
        result: "ok",
        isError: true,
      },
    ])
  })

  it("maps tool-result omitting absent input, error, and callKey", () => {
    expect(captureEventToActions({ type: "tool-result", toolName: "bash", result: "ok" })).toEqual([
      { type: "TOOL_RESULT", toolName: "bash", result: "ok" },
    ])
  })

  it("uses the result's tool_use id as the callKey (no input needed)", () => {
    expect(
      captureEventToActions({ type: "tool-result", toolName: "bash", result: "ok", id: "tu_7" })
    ).toEqual([{ type: "TOOL_RESULT", toolName: "bash", callKey: "tu_7", result: "ok" }])
  })

  it("maps a usage event to SET_USAGE", () => {
    expect(
      captureEventToActions({ type: "usage", usage: { inputTokens: 5, totalCostUsd: 0.01 } })
    ).toEqual([{ type: "SET_USAGE", usage: { inputTokens: 5, totalCostUsd: 0.01 } }])
  })

  it("maps partial context occupancy without accumulating billable usage", () => {
    expect(
      captureEventToActions({
        type: "usage",
        partial: true,
        usage: { contextTokens: 24_000, contextWindow: 1_000_000 },
      })
    ).toEqual([{ type: "SET_CONTEXT_USAGE", used: 24_000, size: 1_000_000 }])
  })

  it("maps a compact event to COMPACT_BOUNDARY", () => {
    expect(
      captureEventToActions({
        type: "compact",
        trigger: "manual",
        preTokens: 45_000,
        postTokens: 8_000,
      })
    ).toEqual([
      { type: "COMPACT_BOUNDARY", trigger: "manual", preTokens: 45_000, postTokens: 8_000 },
    ])
  })

  it("ignores unknown event types", () => {
    expect(captureEventToActions({ type: "mystery" } as unknown as CaptureStreamEvent)).toEqual([])
  })
})

describe("canonicalEnvelopeToActions", () => {
  const envelope = (event: CanonicalAgentEvent): AgentEventEnvelope => ({
    schemaVersion: 1,
    eventId: `e-${event.kind}`,
    sequence: 1,
    sessionId: "s1",
    runId: "r1",
    turnId: "t1",
    attemptId: "a1",
    hostRef: "test",
    runtime: "fake",
    timestamp: "2026-08-04T00:00:00.000Z",
    event,
  })

  it("classifies every known canonical event explicitly", () => {
    expect(Object.keys(CANONICAL_TUI_CLASSIFICATION).sort()).toEqual(
      [...CANONICAL_AGENT_EVENT_KINDS].sort()
    )
    for (const kind of CANONICAL_AGENT_EVENT_KINDS) {
      expect(classifyCanonicalEvent(kind)).not.toBe("unsupported")
    }
  })

  it("maps canonical streaming events through the existing reducer actions", () => {
    expect(
      canonicalEnvelopeToActions(envelope({ kind: "commentary-delta", delta: "Checking" }))
    ).toEqual([
      {
        type: "COMMENTARY_DELTA",
        eventId: "e-commentary-delta",
        messageId: "e-commentary-delta",
        delta: "Checking",
        done: false,
      },
    ])
    expect(canonicalEnvelopeToActions(envelope({ kind: "text-delta", delta: "hello" }))).toEqual([
      { type: "INFLIGHT_TEXT", delta: "hello" },
    ])
    expect(
      canonicalEnvelopeToActions(
        envelope({
          kind: "tool-call",
          toolCallId: "tu-1",
          toolName: "Read",
          input: { path: "README.md" },
        })
      )
    ).toEqual([
      {
        type: "TOOL_CALL",
        callKey: "tu-1",
        toolName: "Read",
        input: { path: "README.md" },
      },
    ])
  })

  it("upserts and removes structured content parts by stable id", () => {
    const part = {
      type: "file" as const,
      name: "notes.txt",
      uri: "artifact://s1/notes.txt",
      mediaType: "text/plain",
    }
    expect(
      canonicalEnvelopeToActions(
        envelope({ kind: "content-part", partId: "p1", operation: "upsert", part })
      )
    ).toEqual([{ type: "CONTENT_PART_UPSERT", partId: "p1", part }])
    expect(
      canonicalEnvelopeToActions(
        envelope({ kind: "content-part", partId: "p1", operation: "remove" })
      )
    ).toEqual([{ type: "CONTENT_PART_REMOVE", partId: "p1" }])
  })

  it("renders future event kinds as a safe unsupported summary", () => {
    const future = envelope({
      kind: "text-delta",
      delta: "unused",
    }) as unknown as AgentEventEnvelope
    ;(future.event as unknown as Record<string, unknown>) = {
      kind: "future-secret-event",
      token: "must-not-render",
    }
    expect(canonicalEnvelopeToActions(future)).toEqual([
      {
        type: "CANONICAL_EVENT_NOTICE",
        eventId: "e-text-delta",
        level: "warning",
        title: "Unsupported event",
        summary: "future-secret-event",
      },
    ])
  })
})
