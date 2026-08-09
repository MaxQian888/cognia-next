import { readFileSync } from "node:fs"
import { join } from "node:path"

import { isAgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import {
  canonicalEventFromCaptureEvent,
  canonicalEventFromExternalEvent,
  captureEventFromCanonical,
  createEnvelopeSequencer,
  isKnownCanonicalAgentEventKind,
} from "./event-envelope"

it("re-exports the canonical event-kind guard at the execution boundary", () => {
  expect(isKnownCanonicalAgentEventKind("text-delta")).toBe(true)
  expect(isKnownCanonicalAgentEventKind("future-event")).toBe(false)
})

// The cross-language contract: the sidecar emitter and this module must
// produce identical envelope shapes for the same context.
const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "sidecar", "dispatch", "agent-event-envelope.fixture.json"),
    "utf8"
  )
) as {
  context: {
    sessionId: string
    runId: string
    attemptId: string
    hostRef: string
    runtime: string
    turnId: string
  }
  cases: Array<{ envelope: Record<string, unknown> }>
}

describe("createEnvelopeSequencer — fixture parity with the sidecar emitter", () => {
  it("produces envelopes whose identity/sequence fields match the pinned fixture", () => {
    const sequencer = createEnvelopeSequencer(fixture.context)
    for (const expected of fixture.cases) {
      const envelope = sequencer(
        expected.envelope.event as Parameters<typeof sequencer>[0]
      ) as unknown as Record<string, unknown>
      expect(isAgentEventEnvelope(envelope)).toBe(true)
      const { timestamp, ...rest } = envelope
      expect(String(timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(rest).toEqual(expected.envelope)
    }
  })

  it("includes parentRunId only when provided", () => {
    const withParent = createEnvelopeSequencer({ ...fixture.context, parentRunId: "root-1" })
    expect(withParent({ kind: "lifecycle", phase: "started" }).parentRunId).toBe("root-1")
    const without = createEnvelopeSequencer(fixture.context)
    expect("parentRunId" in without({ kind: "lifecycle", phase: "started" })).toBe(false)
  })
})

describe("canonicalEventFromExternalEvent", () => {
  it("maps text/thinking/tool/permission/lifecycle/error kinds", () => {
    expect(canonicalEventFromExternalEvent({ type: "text", text: "hi" })).toEqual({
      kind: "text-delta",
      delta: "hi",
    })
    expect(
      canonicalEventFromExternalEvent({
        type: "tool_call",
        name: "Bash",
        input: { c: 1 },
        id: "t1",
      })
    ).toEqual({ kind: "tool-call", toolName: "Bash", input: { c: 1 }, toolCallId: "t1" })
    expect(
      canonicalEventFromExternalEvent({ type: "tool_result", name: "Bash", id: "t1", result: "ok" })
    ).toMatchObject({ kind: "tool-result", toolName: "Bash", result: "ok" })
    expect(
      canonicalEventFromExternalEvent({
        type: "permission_request",
        requestId: "r1",
        toolName: "Edit",
      })
    ).toMatchObject({ kind: "permission-request", requestId: "r1" })
    expect(canonicalEventFromExternalEvent({ type: "session_started" })).toEqual({
      kind: "lifecycle",
      phase: "started",
    })
    expect(
      canonicalEventFromExternalEvent({ type: "error", message: "boom", code: "acp_error" })
    ).toEqual({ kind: "failure", code: "acp_error", message: "boom" })
    expect(
      canonicalEventFromExternalEvent({
        type: "commentary_delta",
        text: "Checking",
        messageId: "c1",
        done: false,
      })
    ).toEqual({
      kind: "commentary-delta",
      delta: "Checking",
      messageId: "c1",
      done: false,
    })
  })

  it("never drops unknown kinds silently — they become diagnostics", () => {
    const event = canonicalEventFromExternalEvent({ type: "vendor_specific", weird: true })
    expect(event).toEqual({
      kind: "diagnostic",
      runtime: "external",
      payload: { type: "vendor_specific", weird: true },
    })
  })
})

describe("canonicalEventFromCaptureEvent", () => {
  it("preserves text and tool identities for the durable recovery log", () => {
    expect(canonicalEventFromCaptureEvent({ type: "text-delta", delta: "partial" })).toEqual({
      kind: "text-delta",
      delta: "partial",
    })
    expect(
      canonicalEventFromCaptureEvent({
        type: "tool-call",
        toolName: "Read",
        input: { path: "a.ts" },
        id: "call-1",
      })
    ).toEqual({
      kind: "tool-call",
      toolName: "Read",
      input: { path: "a.ts" },
      toolCallId: "call-1",
    })
    expect(
      canonicalEventFromCaptureEvent({
        type: "tool-result",
        toolName: "Read",
        id: "call-1",
        result: "ok",
      })
    ).toMatchObject({ kind: "tool-result", toolCallId: "call-1", result: "ok" })
  })

  it("omits the legacy-only tool summary event", () => {
    expect(
      canonicalEventFromCaptureEvent({
        type: "tool-summary",
        summary: "done",
        toolCallIds: ["call-1"],
      })
    ).toBeNull()
  })
})

describe("captureEventFromCanonical", () => {
  it("narrows stream kinds to the legacy capture union", () => {
    expect(captureEventFromCanonical({ kind: "text-delta", delta: "x" })).toEqual({
      type: "text-delta",
      delta: "x",
    })
    expect(
      captureEventFromCanonical({ kind: "compact", trigger: "auto", preTokens: 9, postTokens: 2 })
    ).toEqual({ type: "compact", trigger: "auto", preTokens: 9, postTokens: 2 })
    expect(
      captureEventFromCanonical({ kind: "tool-call", toolName: "Bash", input: {}, toolCallId: "t" })
    ).toMatchObject({ type: "tool-call", toolName: "Bash" })
    expect(
      captureEventFromCanonical({
        kind: "commentary-delta",
        delta: "Checking",
        messageId: "c1",
        done: true,
      })
    ).toEqual({
      type: "commentary-delta",
      delta: "Checking",
      messageId: "c1",
      done: true,
    })
    expect(
      captureEventFromCanonical({
        kind: "tool-summary",
        summary: "Read two files",
        toolCallIds: ["t1", "t2"],
      })
    ).toEqual({ type: "tool-summary", summary: "Read two files", toolCallIds: ["t1", "t2"] })
  })

  it("returns null for envelope-only kinds", () => {
    expect(captureEventFromCanonical({ kind: "lifecycle", phase: "ended" })).toBeNull()
    expect(
      captureEventFromCanonical({ kind: "permission-resolved", requestId: "r", behavior: "allow" })
    ).toBeNull()
    expect(
      captureEventFromCanonical({ kind: "diagnostic", runtime: "sidecar", payload: {} })
    ).toBeNull()
  })
})
