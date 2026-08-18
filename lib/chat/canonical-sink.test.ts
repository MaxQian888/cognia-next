/** @jest-environment jsdom */
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type { SDKMessage } from "@cognia/agent-config-types"

const appendMock = jest.fn<Promise<number>, [string, readonly AgentEventEnvelope[]]>()

jest.mock("@/lib/ai/agent/recovery/canonical-log", () => ({
  appendCanonicalEnvelopes: (...args: unknown[]) =>
    appendMock(...(args as [string, readonly AgentEventEnvelope[]])),
}))

import { armTraceDebugSession, disarmTraceDebugSession } from "@/lib/observability/debug-session"
import {
  __flushChatCanonicalLogForTesting,
  __pendingChatEnvelopeCountForTesting,
  __resetChatCanonicalSinkForTesting,
  chatCanonicalRunId,
  closeChatCanonicalLog,
  openChatCanonicalLog,
  recordChatCanonicalEvents,
  recordChatSdkMessage,
} from "./canonical-sink"

function sdk(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage
}

/** Every envelope handed to the durable log across all flushes. */
function written(): AgentEventEnvelope[] {
  return appendMock.mock.calls.flatMap(([, envelopes]) => [...envelopes])
}

function kinds(): string[] {
  return written().map((envelope) => (envelope.event as { kind: string }).kind)
}

beforeEach(() => {
  appendMock.mockReset()
  appendMock.mockResolvedValue(0)
  localStorage.clear()
  __resetChatCanonicalSinkForTesting()
})

afterEach(() => {
  disarmTraceDebugSession()
  __resetChatCanonicalSinkForTesting()
})

describe("openChatCanonicalLog", () => {
  it("opens the turn with a lifecycle event on the execution run id", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    expect(chatCanonicalRunId("s1")).toBe("run-1")
    await closeChatCanonicalLog("s1")
    expect(appendMock).toHaveBeenCalled()
    // The run id is the join key shared with spans and usage rows.
    expect(appendMock.mock.calls[0][0]).toBe("run-1")
    expect(kinds()).toEqual(["lifecycle", "lifecycle"])
    expect(written()[0].event).toEqual({ kind: "lifecycle", phase: "started" })
    expect(written()[1].event).toEqual({ kind: "lifecycle", phase: "ended" })
  })

  it("is idempotent for the same run so a retry cannot restart the sequence", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    recordChatCanonicalEvents("s1", [{ kind: "warning", code: "w", message: "m" }])
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    await closeChatCanonicalLog("s1")
    const sequences = written().map((envelope) => envelope.sequence)
    expect(sequences).toEqual([0, 1, 2])
  })

  it("seals a previous turn that never closed instead of dropping its buffer", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    recordChatCanonicalEvents("s1", [{ kind: "warning", code: "w", message: "m" }])
    openChatCanonicalLog({ sessionId: "s1", runId: "run-2" })
    await closeChatCanonicalLog("s1")
    const runs = appendMock.mock.calls.map(([runId]) => runId)
    expect(runs).toContain("run-1")
    expect(runs).toContain("run-2")
    // The abandoned turn is sealed as interrupted, not silently ended.
    const firstRun = written().filter((e) => e.runId === "run-1")
    expect(firstRun.map((e) => (e.event as { phase?: string }).phase)).toContain("interrupted")
  })

  it("keeps the prompt out of the log unless the prompts tier is armed", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1", prompt: "my secret prompt" })
    await closeChatCanonicalLog("s1")
    expect(JSON.stringify(written())).not.toContain("my secret prompt")

    appendMock.mockClear()
    armTraceDebugSession({ tiers: ["prompts"] })
    openChatCanonicalLog({ sessionId: "s2", runId: "run-2", prompt: "my secret prompt" })
    await closeChatCanonicalLog("s2")
    expect(kinds()).toContain("user-input")
  })
})

describe("recordChatSdkMessage", () => {
  it("does nothing when no turn is open", async () => {
    recordChatSdkMessage("s1", sdk({ type: "assistant", message: { content: [] } }))
    await __flushChatCanonicalLogForTesting("s1")
    expect(appendMock).not.toHaveBeenCalled()
  })

  it("fills in the tool name the SDK omits from the result block", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    recordChatSdkMessage(
      "s1",
      sdk({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
      })
    )
    recordChatSdkMessage(
      "s1",
      sdk({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      })
    )
    await closeChatCanonicalLog("s1")
    const result = written().find((e) => (e.event as { kind: string }).kind === "tool-result")
    // Read back from the log a result would otherwise say "unknown".
    expect((result?.event as { toolName: string }).toolName).toBe("Bash")
  })

  it("drops streaming deltas unless armed", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    for (let i = 0; i < 50; i++) {
      recordChatSdkMessage(
        "s1",
        sdk({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
        })
      )
    }
    await closeChatCanonicalLog("s1")
    expect(kinds()).toEqual(["lifecycle", "lifecycle"])
  })

  it("keeps streaming deltas while a debug session is armed", async () => {
    armTraceDebugSession({ tiers: ["deltas"] })
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    recordChatSdkMessage(
      "s1",
      sdk({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      })
    )
    await closeChatCanonicalLog("s1")
    expect(kinds()).toContain("text-delta")
  })

  it("respects a session-scoped debug session", async () => {
    armTraceDebugSession({ tiers: ["deltas"], sessionId: "other" })
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    recordChatSdkMessage(
      "s1",
      sdk({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      })
    )
    await closeChatCanonicalLog("s1")
    expect(kinds()).not.toContain("text-delta")
  })
})

describe("redaction", () => {
  it("scrubs credentials out of a captured tool argument", async () => {
    armTraceDebugSession({ tiers: ["toolDetails"] })
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    recordChatSdkMessage(
      "s1",
      sdk({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "curl -H 'x: sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH'" },
            },
          ],
        },
      })
    )
    await closeChatCanonicalLog("s1")
    // Redaction runs at the envelope boundary, so no caller can forget it.
    expect(JSON.stringify(written())).not.toContain("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH")
  })
})

describe("batching", () => {
  it("buffers rather than writing once per event", () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    recordChatCanonicalEvents("s1", [{ kind: "warning", code: "a", message: "a" }])
    recordChatCanonicalEvents("s1", [{ kind: "warning", code: "b", message: "b" }])
    // A Dexie transaction per streamed token is what this avoids.
    expect(appendMock).not.toHaveBeenCalled()
    expect(__pendingChatEnvelopeCountForTesting("s1")).toBe(3)
  })

  it("flushes without waiting for the timer once the buffer fills", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    for (let i = 0; i < 80; i++) {
      recordChatCanonicalEvents("s1", [{ kind: "warning", code: `c${i}`, message: "m" }])
    }
    // The buffer is drained synchronously; the append itself lands a microtask
    // later, which is what keeps it off the caller's stack.
    expect(__pendingChatEnvelopeCountForTesting("s1")).toBeLessThan(64)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(appendMock).toHaveBeenCalled()
    await closeChatCanonicalLog("s1")
    expect(written()).toHaveLength(82)
  })

  it("assigns strictly increasing sequence numbers across flushes", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    for (let i = 0; i < 80; i++) {
      recordChatCanonicalEvents("s1", [{ kind: "warning", code: `c${i}`, message: "m" }])
    }
    await closeChatCanonicalLog("s1")
    const sequences = written().map((envelope) => envelope.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(new Set(sequences).size).toBe(sequences.length)
  })
})

describe("closeChatCanonicalLog", () => {
  it("is idempotent and safe for an unknown session", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    await closeChatCanonicalLog("s1")
    const after = appendMock.mock.calls.length
    await closeChatCanonicalLog("s1")
    await closeChatCanonicalLog("never-opened")
    expect(appendMock.mock.calls.length).toBe(after)
  })

  it("does not let a failed append reject the caller", async () => {
    appendMock.mockRejectedValue(new Error("dexie is gone"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    // Sealing a turn must not fail because telemetry could not be written.
    await expect(closeChatCanonicalLog("s1")).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("stops recording after the turn is sealed", async () => {
    openChatCanonicalLog({ sessionId: "s1", runId: "run-1" })
    await closeChatCanonicalLog("s1")
    appendMock.mockClear()
    recordChatCanonicalEvents("s1", [{ kind: "warning", code: "late", message: "m" }])
    await __flushChatCanonicalLogForTesting("s1")
    expect(appendMock).not.toHaveBeenCalled()
  })
})
