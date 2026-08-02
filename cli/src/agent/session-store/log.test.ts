import path from "node:path"

import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"

import {
  appendEnvelopes,
  decodeEventLog,
  encodeEnvelope,
  materializeSession,
  readEventLog,
} from "./log"
import { eventLogPath } from "./paths"
import { createMemoryFs } from "./test-fs"

const HOME = path.join(path.sep, "home", "u", ".cognia")

let sequence = 0
function envelope(
  event: CanonicalAgentEvent,
  turnId = "t1",
  timestamp = "2026-01-01T00:00:00.000Z"
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `s1:a1:${sequence}`,
    sequence: sequence++,
    sessionId: "s1",
    runId: "r1",
    turnId,
    attemptId: "a1",
    hostRef: "headless-agent-host",
    runtime: "claude-agent-sdk",
    timestamp,
    event,
  }
}

beforeEach(() => {
  sequence = 0
})

describe("append / read round-trip", () => {
  it("appends a batch as one write and reads it back in order", () => {
    const fsx = createMemoryFs()
    const batch = [
      envelope({ kind: "user-input", text: "hi" }),
      envelope({ kind: "text-delta", delta: "hello" }),
    ]
    appendEnvelopes(HOME, "s1", batch, fsx)
    expect(fsx.files.get(eventLogPath(HOME, "s1"))).toBe(batch.map(encodeEnvelope).join(""))

    const read = readEventLog(HOME, "s1", fsx)
    expect(read.envelopes.map((e) => e.sequence)).toEqual([0, 1])
    expect(read.invalidLines).toBe(0)
    expect(read.truncatedTail).toBe(false)
  })

  it("appends without rewriting earlier lines", () => {
    const fsx = createMemoryFs()
    appendEnvelopes(HOME, "s1", [envelope({ kind: "user-input", text: "one" })], fsx)
    const afterFirst = fsx.files.get(eventLogPath(HOME, "s1")) ?? ""
    appendEnvelopes(HOME, "s1", [envelope({ kind: "user-input", text: "two" })], fsx)
    expect(fsx.files.get(eventLogPath(HOME, "s1"))?.startsWith(afterFirst)).toBe(true)
  })

  it("writes nothing for an empty batch and reads a missing log as empty", () => {
    const fsx = createMemoryFs()
    appendEnvelopes(HOME, "s1", [], fsx)
    expect(fsx.files.has(eventLogPath(HOME, "s1"))).toBe(false)
    expect(readEventLog(HOME, "s1", fsx).envelopes).toEqual([])
  })

  it("honours a --session-dir override", () => {
    const fsx = createMemoryFs()
    const override = path.join(path.sep, "tmp", "store")
    appendEnvelopes(HOME, "s1", [envelope({ kind: "user-input", text: "hi" })], fsx, override)
    expect(fsx.files.has(eventLogPath(HOME, "s1", override))).toBe(true)
    expect(readEventLog(HOME, "s1", fsx, override).envelopes).toHaveLength(1)
  })
})

describe("decodeEventLog accounting", () => {
  it("counts unparsable lines separately from invalid envelopes", () => {
    const good = encodeEnvelope(envelope({ kind: "text-delta", delta: "x" }))
    const raw = `${good}{ not json\n${JSON.stringify({ hello: "world" })}\n`
    const read = decodeEventLog(raw)
    expect(read.envelopes).toHaveLength(1)
    expect(read.unparsableLines).toBe(1)
    expect(read.invalidLines).toBe(1)
  })

  it("flags a truncated tail when the last write was interrupted", () => {
    const good = encodeEnvelope(envelope({ kind: "text-delta", delta: "x" }))
    expect(decodeEventLog(good).truncatedTail).toBe(false)
    expect(decodeEventLog(`${good}{"partial"`).truncatedTail).toBe(true)
  })

  it("ignores blank lines and handles an empty or missing body", () => {
    expect(decodeEventLog("\n\n\n").envelopes).toEqual([])
    expect(decodeEventLog("").envelopes).toEqual([])
    expect(decodeEventLog(null).truncatedTail).toBe(false)
  })

  it("rejects an envelope missing schemaVersion as invalid, not as content", () => {
    const legacyShaped = { ...envelope({ kind: "text-delta", delta: "x" }) } as Record<
      string,
      unknown
    >
    delete legacyShaped.schemaVersion
    const read = decodeEventLog(`${JSON.stringify(legacyShaped)}\n`)
    expect(read.envelopes).toEqual([])
    expect(read.invalidLines).toBe(1)
  })
})

describe("materializeSession", () => {
  it("pairs a user turn with the assistant turn from the same turnId", () => {
    const result = materializeSession([
      envelope({ kind: "user-input", text: "hi" }),
      envelope({ kind: "text-delta", delta: "he" }),
      envelope({ kind: "text-delta", delta: "llo" }),
    ])
    expect(result.turns).toEqual([
      { turnId: "t1:user", role: "user", text: "hi", at: "2026-01-01T00:00:00.000Z" },
      {
        turnId: "t1:assistant",
        role: "assistant",
        text: "hello",
        at: "2026-01-01T00:00:00.000Z",
      },
    ])
    expect(result.lastAssistantText).toBe("hello")
  })

  it("keeps multi-turn conversations in first-sight order", () => {
    const result = materializeSession([
      envelope({ kind: "user-input", text: "one" }, "t1"),
      envelope({ kind: "text-delta", delta: "first" }, "t1"),
      envelope({ kind: "user-input", text: "two" }, "t2"),
      envelope({ kind: "text-delta", delta: "second" }, "t2"),
    ])
    expect(result.turns.map((t) => t.text)).toEqual(["one", "first", "two", "second"])
  })

  it("keeps a user turn whose assistant side never produced anything, in place", () => {
    const result = materializeSession([
      envelope({ kind: "user-input", text: "one" }, "t1"),
      envelope({ kind: "text-delta", delta: "first" }, "t1"),
      envelope({ kind: "user-input", text: "cancelled" }, "t2"),
      envelope({ kind: "lifecycle", phase: "interrupted" }, "t2"),
      envelope({ kind: "user-input", text: "three" }, "t3"),
      envelope({ kind: "text-delta", delta: "third" }, "t3"),
    ])
    expect(result.turns.map((t) => t.text)).toEqual(["one", "first", "cancelled", "three", "third"])
  })

  it("never folds thinking deltas into assistant text", () => {
    const result = materializeSession([
      envelope({ kind: "thinking-delta", delta: "private reasoning" }),
      envelope({ kind: "text-delta", delta: "public" }),
    ])
    expect(result.turns[0]?.text).toBe("public")
  })

  it("attaches a tool call and merges its result onto the same callId", () => {
    const result = materializeSession([
      envelope({ kind: "user-input", text: "run it" }),
      envelope({ kind: "tool-call", toolName: "Bash", input: { command: "ls" }, toolCallId: "c1" }),
      envelope({ kind: "tool-result", toolName: "Bash", toolCallId: "c1", result: "a\nb" }),
    ])
    const assistant = result.turns.find((t) => t.role === "assistant")
    expect(assistant?.toolCalls).toEqual([
      { callId: "c1", toolName: "Bash", input: { command: "ls" }, resultText: "a\nb" },
    ])
  })

  it("records an orphan tool result and marks tool errors", () => {
    const result = materializeSession([
      envelope({ kind: "tool-result", toolName: "Read", result: { ok: false }, isError: true }),
    ])
    const assistant = result.turns.find((t) => t.role === "assistant")
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      toolName: "Read",
      resultText: '{"ok":false}',
      isError: true,
    })
  })

  it("synthesizes call ids when the runtime supplied none", () => {
    const result = materializeSession([
      envelope({ kind: "tool-call", toolName: "Read", input: {} }),
      envelope({ kind: "tool-call", toolName: "Grep", input: {} }),
    ])
    const calls = result.turns[0]?.toolCalls ?? []
    expect(calls.map((c) => c.callId)).toEqual(["t1:call:0", "t1:call:1"])
  })

  it("sums partial usage events across a multi-step turn instead of last-wins", () => {
    const result = materializeSession([
      envelope({ kind: "text-delta", delta: "x" }),
      envelope({ kind: "usage", usage: { input_tokens: 10, output_tokens: 2 }, partial: true }),
      envelope({ kind: "usage", usage: { inputTokens: 5, outputTokens: 3 } }),
    ])
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 5 })
    expect(result.turns[0]?.usage).toEqual({ inputTokens: 15, outputTokens: 5 })
  })

  it("ignores non-numeric usage values rather than producing NaN", () => {
    const result = materializeSession([
      envelope({ kind: "text-delta", delta: "x" }),
      envelope({ kind: "usage", usage: { input_tokens: "many" } }),
    ])
    expect(result.usage).toEqual({})
  })

  it("resolves permission requests and records checkpoints", () => {
    const result = materializeSession([
      envelope({ kind: "permission-request", requestId: "p1", toolName: "Bash" }),
      envelope({ kind: "permission-resolved", requestId: "p1", behavior: "allow" }),
      envelope({ kind: "permission-request", requestId: "p2", toolName: "Write" }),
      envelope({ kind: "permission-resolved", requestId: "p2", behavior: "deny" }),
      envelope({ kind: "permission-resolved", requestId: "unknown", behavior: "allow" }),
      envelope({ kind: "checkpoint", checkpointId: "cp1" }),
    ])
    expect(result.permissions).toEqual([
      { requestId: "p1", toolName: "Bash", decision: "allow", at: "2026-01-01T00:00:00.000Z" },
      { requestId: "p2", toolName: "Write", decision: "deny", at: "2026-01-01T00:00:00.000Z" },
    ])
    expect(result.checkpoints).toEqual([{ checkpointId: "cp1", afterTurnId: "t1:assistant" }])
  })

  it("reports an empty last assistant text when nothing was produced", () => {
    const result = materializeSession([envelope({ kind: "user-input", text: "hi" })])
    expect(result.lastAssistantText).toBe("")
    expect(result.turns).toHaveLength(1)
  })

  it("returns an empty session for an empty log", () => {
    expect(materializeSession([])).toEqual({
      turns: [],
      permissions: [],
      checkpoints: [],
      lastAssistantText: "",
    })
  })
})
