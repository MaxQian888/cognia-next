import { mapPiEvent, piResultToText, piStatsToTokenUsage, type PiEvent } from "./pi-rpc-events"
import { PI_PERMISSION_MARKER, encodePiPermissionTitle } from "./pi-permission"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"

const TS = new Date("2026-08-14T00:00:00.000Z")
const ctx = { sessionId: "sess-1", now: () => TS }

const map = (event: PiEvent): ExternalAgentEvent[] => mapPiEvent(event, ctx)
const types = (event: PiEvent): string[] => map(event).map((e) => e.type)

const update = (assistantMessageEvent: Record<string, unknown>): PiEvent => ({
  type: "message_update",
  assistantMessageEvent,
})

describe("piResultToText", () => {
  it("joins text blocks and ignores non-text ones", () => {
    expect(
      piResultToText({
        content: [
          { type: "text", text: "a" },
          { type: "image", text: "ignored" },
          { type: "text", text: "b" },
        ],
      })
    ).toBe("ab")
  })

  it("returns empty for missing or empty content", () => {
    expect(piResultToText(undefined)).toBe("")
    expect(piResultToText({})).toBe("")
    expect(piResultToText({ content: [] })).toBe("")
  })
})

describe("piStatsToTokenUsage", () => {
  it("projects tokens, cache traffic and context occupancy", () => {
    expect(
      piStatsToTokenUsage({
        tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
        contextUsage: { tokens: 400, contextWindow: 1000, percent: 40 },
      })
    ).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 18,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      contextTokens: 400,
      modelContextWindow: 1000,
    })
  })

  it("prefers Pi's own total over recomputing it", () => {
    // Pi counts cache traffic in `total`; recomputing would disagree with
    // the number Pi shows for the same session.
    const usage = piStatsToTokenUsage({ tokens: { input: 10, output: 5, total: 99 } })
    expect(usage?.totalTokens).toBe(99)
  })

  it("falls back to input+output when total is absent", () => {
    expect(piStatsToTokenUsage({ tokens: { input: 10, output: 5 } })?.totalTokens).toBe(15)
  })

  it("returns undefined when there is nothing to report", () => {
    expect(piStatsToTokenUsage(undefined)).toBeUndefined()
    expect(piStatsToTokenUsage({})).toBeUndefined()
  })
})

describe("mapPiEvent — messages", () => {
  it("maps message_start and message_end", () => {
    expect(map({ type: "message_start" })).toEqual([
      { sessionId: "sess-1", timestamp: TS, type: "message_start", role: "assistant" },
    ])
    expect(types({ type: "message_end" })).toEqual(["message_end"])
  })

  it("forwards text deltas", () => {
    expect(map(update({ type: "text_delta", contentIndex: 0, delta: "Hello" }))).toEqual([
      {
        sessionId: "sess-1",
        timestamp: TS,
        type: "message_delta",
        delta: { type: "text", text: "Hello" },
      },
    ])
  })

  it("routes thinking deltas to the thinking event, not message text", () => {
    expect(map(update({ type: "thinking_delta", delta: "hmm" }))).toEqual([
      { sessionId: "sess-1", timestamp: TS, type: "thinking", thinking: "hmm" },
    ])
  })

  /**
   * `text_end` repeats the whole block as `content`. Emitting it would render
   * every streamed message twice, which is the failure mode this drops.
   */
  it("ignores block start/end markers", () => {
    expect(types(update({ type: "text_start", contentIndex: 0 }))).toEqual([])
    expect(types(update({ type: "text_end", contentIndex: 0, content: "Hello world" }))).toEqual([])
    expect(types(update({ type: "thinking_start" }))).toEqual([])
    expect(types(update({ type: "thinking_end" }))).toEqual([])
    expect(types(update({ type: "toolcall_start" }))).toEqual([])
  })

  it("ignores an empty delta rather than emitting a blank chunk", () => {
    expect(types(update({ type: "text_delta", delta: "" }))).toEqual([])
    expect(types(update({ type: "thinking_delta" }))).toEqual([])
  })

  it("ignores a malformed or absent assistantMessageEvent", () => {
    expect(types({ type: "message_update" })).toEqual([])
    expect(types({ type: "message_update", assistantMessageEvent: { nope: 1 } })).toEqual([])
  })

  it("maps a completed tool call from toolcall_end", () => {
    expect(
      map(
        update({
          type: "toolcall_end",
          toolCall: { id: "call_1", name: "bash", arguments: { command: "ls" } },
        })
      )
    ).toEqual([
      {
        sessionId: "sess-1",
        timestamp: TS,
        type: "tool_use_end",
        toolUseId: "call_1",
        input: { command: "ls" },
      },
    ])
  })

  it("drops tool-call deltas that have no id to correlate against", () => {
    expect(types(update({ type: "toolcall_delta", delta: '{"cmd' }))).toEqual([])
    expect(
      types(update({ type: "toolcall_delta", delta: '{"cmd', toolCall: { id: "c1" } }))
    ).toEqual(["tool_use_delta"])
  })
})

describe("mapPiEvent — tools", () => {
  it("maps execution start to tool_use_start with its arguments", () => {
    expect(
      map({
        type: "tool_execution_start",
        toolCallId: "call_abc",
        toolName: "bash",
        args: { command: "ls -la" },
      })
    ).toEqual([
      {
        sessionId: "sess-1",
        timestamp: TS,
        type: "tool_use_start",
        toolUseId: "call_abc",
        toolName: "bash",
        rawInput: { command: "ls -la" },
      },
    ])
  })

  /**
   * `partialResult` is cumulative, not incremental. Mapping it to a delta
   * event would make the UI append the whole output on every update.
   */
  it("maps a cumulative partial result to a replace-semantics update", () => {
    const [event] = map({
      type: "tool_execution_update",
      toolCallId: "call_abc",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "so far" }] },
    })
    expect(event.type).toBe("tool_call_update")
    expect(event).toMatchObject({ toolCallId: "call_abc", status: "in_progress" })
  })

  it("maps execution end to a completed tool result", () => {
    expect(
      map({
        type: "tool_execution_end",
        toolCallId: "call_abc",
        toolName: "bash",
        result: { content: [{ type: "text", text: "total 48" }] },
        isError: false,
      })
    ).toEqual([
      {
        sessionId: "sess-1",
        timestamp: TS,
        type: "tool_result",
        toolUseId: "call_abc",
        toolName: "bash",
        result: "total 48",
        isError: false,
        rawOutput: { content: [{ type: "text", text: "total 48" }] },
        status: "completed",
      },
    ])
  })

  it("marks a failed tool result", () => {
    const [event] = map({
      type: "tool_execution_end",
      toolCallId: "c",
      result: { content: [{ type: "text", text: "boom" }] },
      isError: true,
    })
    expect(event).toMatchObject({ isError: true, status: "failed" })
  })

  it("drops tool events with no correlation id", () => {
    expect(types({ type: "tool_execution_start", toolName: "bash" })).toEqual([])
    expect(types({ type: "tool_execution_update" })).toEqual([])
    expect(types({ type: "tool_execution_end" })).toEqual([])
  })
})

describe("mapPiEvent — completion", () => {
  /**
   * The single most consequential mapping in this file. `agent_end` and
   * `turn_end` can each be followed by an automatic retry or a queued
   * continuation, so treating either as completion truncates the turn.
   */
  it("completes only on agent_settled", () => {
    expect(map({ type: "agent_settled" })).toEqual([
      { sessionId: "sess-1", timestamp: TS, type: "done", success: true },
    ])
    for (const type of ["agent_end", "turn_end", "agent_start", "turn_start"]) {
      expect(types({ type })).toEqual(["progress"])
    }
  })

  it("maps every non-terminal lifecycle event to indeterminate progress", () => {
    for (const type of [
      "compaction_start",
      "compaction_end",
      "auto_retry_start",
      "auto_retry_end",
      "summarization_retry_scheduled",
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
      "queue_update",
      "bash_execution_update",
    ]) {
      const [event] = map({ type })
      expect(event).toMatchObject({ type: "progress", progress: -1 })
    }
  })

  it("reports an extension error as recoverable", () => {
    expect(map({ type: "extension_error", error: "handler threw" })).toEqual([
      {
        sessionId: "sess-1",
        timestamp: TS,
        type: "error",
        error: "handler threw",
        recoverable: true,
      },
    ])
  })

  it("ignores unknown event types instead of failing the turn", () => {
    // Pi adds events between releases; an unrecognised one is not an error.
    expect(types({ type: "some_future_pi_event", payload: 1 })).toEqual([])
  })
})

describe("mapPiEvent — extension UI", () => {
  it("maps fire-and-forget methods to progress", () => {
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      const [event] = map({ type: "extension_ui_request", id: "u1", method, title: "hi" })
      expect(event).toMatchObject({ type: "progress" })
    }
  })

  it("maps a select dialog to an elicitation with its options", () => {
    const [event] = map({
      type: "extension_ui_request",
      id: "uuid-1",
      method: "select",
      title: "Allow dangerous command?",
      options: ["Allow", "Block"],
      timeout: 10000,
    })
    expect(event.type).toBe("elicitation_request")
    const request = (event as Extract<ExternalAgentEvent, { type: "elicitation_request" }>).request
    expect(request.id).toBe("uuid-1")
    expect(request.mode).toBe("form")
    expect(request.message).toBe("Allow dangerous command?")
    expect(request.requestedSchema?.properties.select).toMatchObject({
      type: "string",
      enum: ["Allow", "Block"],
    })
    // `raw` must preserve the method and timeout so a responder can honour
    // the original request without this mapper modelling every field.
    expect(request.raw).toMatchObject({ method: "select", timeout: 10000 })
  })

  it("maps a confirm dialog to a boolean property", () => {
    const [event] = map({
      type: "extension_ui_request",
      id: "uuid-2",
      method: "confirm",
      title: "Clear session?",
      message: "All messages will be lost.",
    })
    const request = (event as Extract<ExternalAgentEvent, { type: "elicitation_request" }>).request
    expect(request.message).toBe("All messages will be lost.")
    expect(request.requestedSchema?.properties.confirm).toMatchObject({ type: "boolean" })
  })

  it("falls back to the title when a dialog carries no message", () => {
    const [event] = map({
      type: "extension_ui_request",
      id: "u3",
      method: "input",
      title: "Branch name?",
    })
    const request = (event as Extract<ExternalAgentEvent, { type: "elicitation_request" }>).request
    expect(request.message).toBe("Branch name?")
  })

  it("never emits a blank prompt", () => {
    const [event] = map({ type: "extension_ui_request", id: "u4", method: "editor" })
    const request = (event as Extract<ExternalAgentEvent, { type: "elicitation_request" }>).request
    expect(request.message).toBe("pi.editor")
  })

  it("drops a dialog with no id, which could never be answered", () => {
    expect(types({ type: "extension_ui_request", method: "confirm" })).toEqual([])
    expect(types({ type: "extension_ui_request", id: "x" })).toEqual([])
  })
})

describe("mapPiEvent — envelope", () => {
  it("stamps every event with the session id", () => {
    for (const event of [
      { type: "message_start" },
      { type: "agent_settled" },
      { type: "tool_execution_start", toolCallId: "c", toolName: "t" },
    ]) {
      expect(map(event)[0].sessionId).toBe("sess-1")
    }
  })

  it("uses wall-clock time when no clock is injected", () => {
    const before = Date.now()
    const [event] = mapPiEvent({ type: "agent_settled" }, { sessionId: "s" })
    expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before)
  })
})

describe("mapPiEvent — native-tool approvals", () => {
  /**
   * An approval and an extension question are different things and must reach
   * different UI. The approval carries the allow/deny affordances and the audit
   * trail; a generic form has neither.
   */
  it("routes a marked confirm to permission_request, not elicitation", () => {
    const [event] = map({
      type: "extension_ui_request",
      id: "dlg-9",
      method: "confirm",
      title: encodePiPermissionTitle({ tool: "bash", mode: "default" }),
      message: "bash: rm -rf dist",
    })

    expect(event.type).toBe("permission_request")
    const request = (event as Extract<ExternalAgentEvent, { type: "permission_request" }>).request
    // The id must stay the DIALOG id — it is what the answer is matched on.
    expect(request.id).toBe("dlg-9")
    expect(request.requestId).toBe("dlg-9")
    expect(request.toolInfo).toMatchObject({ id: "bash", name: "bash" })
    // The marker never reaches the user; the mapper rebuilds a clean title.
    expect(request.title).toBe("Allow bash?")
    expect(request.title).not.toContain(PI_PERMISSION_MARKER)
    expect(request.reason).toBe("bash: rm -rf dist")
    expect(request.options?.map((o) => o.optionId)).toEqual(["allow", "reject"])
  })

  it("leaves an ordinary confirm as an elicitation", () => {
    const [event] = map({
      type: "extension_ui_request",
      id: "dlg-10",
      method: "confirm",
      title: "Clear session?",
      message: "All messages will be lost.",
    })
    expect(event.type).toBe("elicitation_request")
  })

  /**
   * The marker is only meaningful on `confirm` — that is the only method the
   * bundled extension raises for an approval. Honouring it elsewhere would let
   * a `select` masquerade as a two-option approval.
   */
  it("ignores the marker on any other dialog method", () => {
    const [event] = map({
      type: "extension_ui_request",
      id: "dlg-11",
      method: "select",
      title: encodePiPermissionTitle({ tool: "bash", mode: "default" }),
      options: ["a", "b"],
    })
    expect(event.type).toBe("elicitation_request")
  })

  it("falls back to elicitation for a marker version it does not understand", () => {
    const [event] = map({
      type: "extension_ui_request",
      id: "dlg-12",
      method: "confirm",
      title: 'cognia-permission/v2 {"tool":"bash"}',
      message: "bash: ls",
    })
    // Degrades to a readable question rather than being interpreted by a build
    // that does not know the v2 payload.
    expect(event.type).toBe("elicitation_request")
  })
})
