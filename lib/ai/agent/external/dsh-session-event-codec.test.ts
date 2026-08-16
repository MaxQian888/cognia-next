import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  DshVersionDriftError,
  dshEventDedupeKey,
  translateDshNotification,
  translateDshNotifications,
} from "./dsh-session-event-codec"

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "dsh")

function loadTrace(name: string): unknown[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

function sessionEvent(type: string, data: unknown, seq = 1) {
  return { method: "session.event", params: { sessionId: "s1", event: { type, seq, data } } }
}

describe("translateDshNotification", () => {
  it("maps turn/start to session_start", () => {
    const { events } = translateDshNotification(sessionEvent("turn/start", { turn: 1 }))
    expect(events).toEqual([expect.objectContaining({ type: "session_start", sessionId: "s1" })])
  })

  it("maps a completed turn/end to a successful done", () => {
    const { events } = translateDshNotification(
      sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } })
    )
    expect(events[0]).toMatchObject({ type: "done", success: true, stopReason: "end_turn" })
  })

  it.each([
    ["max-tokens", "max_tokens"],
    ["aborted", "cancelled"],
    ["interrupted", "cancelled"],
    ["blocked", "refusal"],
  ])("maps turn/end reason %s to %s without claiming success", (kind, stopReason) => {
    const { events } = translateDshNotification(sessionEvent("turn/end", { reason: { kind } }))
    expect(events[0]).toMatchObject({ type: "done", success: false, stopReason })
  })

  it("treats an unmapped turn/end reason as an error rather than success", () => {
    // An unrecognized terminal reason is not evidence the turn completed.
    const { events } = translateDshNotification(
      sessionEvent("turn/end", { reason: { kind: "some-future-reason" } })
    )
    expect(events[0]).toMatchObject({ type: "done", success: false })
    expect(events[0]).not.toHaveProperty("stopReason")
  })

  it("maps a text-delta chunk to a text message_delta", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", { chunk: { type: "text-delta", text: "hi" } })
    )
    expect(events[0]).toMatchObject({ type: "message_delta", delta: { type: "text", text: "hi" } })
  })

  it("maps a reasoning-delta chunk to thinking, not commentary", () => {
    // Reasoning stays governed by the reasoning disclosure policy; commentary
    // is user-visible narration and would leak it.
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", { chunk: { type: "reasoning-delta", text: "pondering" } })
    )
    expect(events[0]).toMatchObject({ type: "thinking", thinking: "pondering" })
  })

  it("drops empty deltas instead of emitting blank events", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", { chunk: { type: "text-delta", text: "" } })
    )
    expect(events).toEqual([])
  })

  it("maps a usage chunk without double-counting cache or reasoning tokens", () => {
    // cacheReadTokens are not newly billed, and reasoningTokens are already
    // inside outputTokens; adding either inflates every total.
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", {
        chunk: {
          type: "usage",
          usage: { inputTokens: 123, outputTokens: 89, cacheReadTokens: 1664, reasoningTokens: 17 },
        },
      })
    )
    expect(events[0]).toMatchObject({ type: "usage_update", used: 212 })
  })

  it("warns on an unknown chunk type without failing", () => {
    // Chunk kinds are presentation detail; the committed message still carries
    // the content, so this must not break the stream.
    const { events, warnings } = translateDshNotification(
      sessionEvent("assistant/chunk", { chunk: { type: "video-delta" } })
    )
    expect(events).toEqual([])
    expect(warnings).toEqual([{ kind: "unknown-chunk-type", detail: "video-delta" }])
  })

  it("maps tool/call with parsed arguments", () => {
    const { events } = translateDshNotification(
      sessionEvent("tool/call", {
        callId: "call_1",
        name: "bash",
        arguments: '{"command":"echo hi"}',
      })
    )
    expect(events[0]).toMatchObject({
      type: "tool_use_start",
      toolUseId: "call_1",
      toolName: "bash",
      rawInput: { command: "echo hi" },
    })
  })

  it("still emits the tool call when arguments are unparsable", () => {
    // A model can emit malformed JSON arguments. The call happened; dropping it
    // would orphan the tool/result that follows.
    const { events, warnings } = translateDshNotification(
      sessionEvent("tool/call", { callId: "c1", name: "bash", arguments: "{not json" })
    )
    expect(events[0]).toMatchObject({
      type: "tool_use_start",
      toolUseId: "c1",
      rawInput: undefined,
    })
    expect(warnings[0]?.kind).toBe("malformed-payload")
  })

  it("maps tool/result and preserves the error flag", () => {
    const { events } = translateDshNotification(
      sessionEvent("tool/result", {
        message: {
          source: { kind: "tool", callId: "call_1" },
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              content: [{ type: "text", text: "denied" }],
              isError: true,
            },
          ],
        },
      })
    )
    expect(events[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call_1",
      result: "denied",
      isError: true,
    })
  })

  it("maps session.status idle to done and ignores running", () => {
    // running -> idle is the only reliable turn boundary: session/prompt returns
    // an inbox-admission receipt, never a turn result.
    expect(
      translateDshNotification({
        method: "session.status",
        params: { sessionId: "s1", status: "idle" },
      }).events[0]
    ).toMatchObject({ type: "done", success: true })
    expect(
      translateDshNotification({
        method: "session.status",
        params: { sessionId: "s1", status: "running" },
      }).events
    ).toEqual([])
  })
})

describe("subagent lineage", () => {
  it("maps subagent.started to a progress marker carrying the child id", () => {
    const { events } = translateDshNotification({
      method: "subagent.started",
      params: { sessionId: "parent", childSessionId: "child-1" },
    })
    expect(events[0]).toMatchObject({
      type: "progress",
      progress: 0,
      message: "subagent:started:child-1",
    })
  })

  it("maps subagent.finished to a completed progress marker", () => {
    const { events } = translateDshNotification({
      method: "subagent.finished",
      params: { sessionId: "parent", childSessionId: "child-1", stopReason: "completed" },
    })
    expect(events[0]).toMatchObject({
      type: "progress",
      progress: 1,
      message: "subagent:finished:child-1",
    })
  })

  it("still emits lineage when the child id is absent", () => {
    // subagent.finished is documented as in-process only, so an out-of-process
    // child may report partial lineage. Losing the event entirely would leave
    // the run looking like it never spawned anything.
    const started = translateDshNotification({
      method: "subagent.started",
      params: { sessionId: "p" },
    })
    const finished = translateDshNotification({
      method: "subagent.finished",
      params: { sessionId: "p" },
    })
    expect(started.events[0]).toMatchObject({ message: "subagent:started:unknown" })
    expect(finished.events[0]).toMatchObject({ message: "subagent:finished:unknown" })
  })
})

describe("partial and unusual payloads", () => {
  it("warns when assistant/chunk carries no chunk object", () => {
    const { events, warnings } = translateDshNotification(sessionEvent("assistant/chunk", {}))
    expect(events).toEqual([])
    expect(warnings[0]).toMatchObject({ kind: "malformed-payload" })
  })

  it("maps a tool-call-delta when it carries both id and delta", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", {
        chunk: { type: "tool-call-delta", id: "c1", delta: '{"cmd":' },
      })
    )
    expect(events[0]).toMatchObject({ type: "tool_use_delta", toolUseId: "c1", delta: '{"cmd":' })
  })

  it("drops a tool-call-delta with no attributable call id", () => {
    // The committed tool/call carries complete arguments, so an unattributable
    // fragment is safe to discard but must not be guessed onto another call.
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", { chunk: { type: "tool-call-delta", delta: "x" } })
    )
    expect(events).toEqual([])
  })

  it("ignores stream framing chunks", () => {
    for (const type of ["block-start", "block-end", "finish"]) {
      const { events, warnings } = translateDshNotification(
        sessionEvent("assistant/chunk", { chunk: { type, blockType: "text" } })
      )
      expect(events).toEqual([])
      expect(warnings).toEqual([])
    }
  })

  it("emits tool_use_start for tool-call blocks in a committed assistant/message", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/message", {
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "tool-call", id: "c9", name: "read" },
          ],
        },
      })
    )
    expect(events).toEqual([
      expect.objectContaining({ type: "tool_use_start", toolUseId: "c9", toolName: "read" }),
    ])
  })

  it("warns when assistant/message has no message", () => {
    const { events, warnings } = translateDshNotification(sessionEvent("assistant/message", {}))
    expect(events).toEqual([])
    expect(warnings[0]).toMatchObject({ kind: "malformed-payload" })
  })

  it("accepts tool/call arguments already given as an object", () => {
    const { events } = translateDshNotification(
      sessionEvent("tool/call", { callId: "c1", name: "bash", arguments: { command: "ls" } })
    )
    expect(events[0]).toMatchObject({ rawInput: { command: "ls" } })
  })

  it("warns when tool/call is missing its name", () => {
    const { events, warnings } = translateDshNotification(
      sessionEvent("tool/call", { callId: "c1" })
    )
    expect(events).toEqual([])
    expect(warnings[0]).toMatchObject({ kind: "malformed-payload" })
  })

  it("warns when tool/result has no attributable call id", () => {
    const { events, warnings } = translateDshNotification(
      sessionEvent("tool/result", { message: { content: [] } })
    )
    expect(events).toEqual([])
    expect(warnings[0]).toMatchObject({ kind: "malformed-payload" })
  })

  it("falls back to a top-level callId on tool/result", () => {
    const { events } = translateDshNotification(
      sessionEvent("tool/result", { callId: "c2", message: { content: [] } })
    )
    expect(events[0]).toMatchObject({ type: "tool_result", toolUseId: "c2", isError: false })
  })

  it("yields empty result text when the result content is not an array", () => {
    const { events } = translateDshNotification(
      sessionEvent("tool/result", {
        message: { source: { callId: "c3" }, content: [{ type: "tool-result", content: "oops" }] },
      })
    )
    expect(events[0]).toMatchObject({ toolUseId: "c3", result: "" })
  })

  it("emits nothing for provenance-only events", () => {
    for (const type of [
      "request/header",
      "request/context",
      "session/title",
      "agent/inbox/spliced",
      "user/message",
    ]) {
      const { events, warnings } = translateDshNotification(sessionEvent(type, {}))
      expect(events).toEqual([])
      expect(warnings).toEqual([])
    }
  })

  it("maps step boundaries to message boundaries", () => {
    expect(translateDshNotification(sessionEvent("step/start", {})).events[0]).toMatchObject({
      type: "message_start",
      role: "assistant",
    })
    expect(translateDshNotification(sessionEvent("step/end", {})).events[0]).toMatchObject({
      type: "message_end",
    })
  })

  it("ignores a usage chunk with no usage object", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", { chunk: { type: "usage" } })
    )
    expect(events).toEqual([])
  })

  it("defaults missing token fields to zero rather than NaN", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", { chunk: { type: "usage", usage: { inputTokens: 5 } } })
    )
    expect(events[0]).toMatchObject({ type: "usage_update", used: 5 })
  })

  it("ignores non-finite token counts instead of propagating NaN", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", {
        chunk: { type: "usage", usage: { inputTokens: Number.NaN, outputTokens: "12" } },
      })
    )
    expect(events[0]).toMatchObject({ type: "usage_update", used: 0 })
  })

  it("accepts a delta field as an alias for text on content chunks", () => {
    // Observed shape uses `text`; the alias keeps a minor upstream rename from
    // silently emptying the stream.
    expect(
      translateDshNotification(
        sessionEvent("assistant/chunk", { chunk: { type: "text-delta", delta: "aliased" } })
      ).events[0]
    ).toMatchObject({ delta: { type: "text", text: "aliased" } })
    expect(
      translateDshNotification(
        sessionEvent("assistant/chunk", { chunk: { type: "reasoning-delta", delta: "aliased" } })
      ).events[0]
    ).toMatchObject({ type: "thinking", thinking: "aliased" })
  })

  it("maps a tool-call-delta keyed by toolCallId", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/chunk", {
        chunk: { type: "tool-call-delta", toolCallId: "c7", arguments: "{" },
      })
    )
    expect(events[0]).toMatchObject({ type: "tool_use_delta", toolUseId: "c7", delta: "{" })
  })

  it("skips non-text blocks when flattening tool result content", () => {
    const { events } = translateDshNotification(
      sessionEvent("tool/result", {
        message: {
          source: { callId: "c4" },
          content: [
            {
              type: "tool-result",
              content: [
                { type: "image", data: "..." },
                { type: "text", text: "ok" },
              ],
            },
          ],
        },
      })
    )
    expect(events[0]).toMatchObject({ toolUseId: "c4", result: "ok" })
  })

  it("tolerates a tool/result whose content array holds non-objects", () => {
    const { events } = translateDshNotification(
      sessionEvent("tool/result", { callId: "c5", message: { content: ["junk"] } })
    )
    expect(events[0]).toMatchObject({ toolUseId: "c5", result: "", isError: false })
  })

  it("tolerates a tool/result with no message at all", () => {
    const { events } = translateDshNotification(sessionEvent("tool/result", { callId: "c6" }))
    expect(events[0]).toMatchObject({ toolUseId: "c6", result: "" })
  })

  it("ignores non-object blocks in a committed assistant/message", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/message", {
        message: { content: ["junk", { type: "tool-call", id: "c8", name: "read" }] },
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ toolUseId: "c8" })
  })

  it("ignores an assistant/message whose content is not an array", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/message", { message: { content: "plain" } })
    )
    expect(events).toEqual([])
  })

  it("skips a tool-call block missing its id or name", () => {
    const { events } = translateDshNotification(
      sessionEvent("assistant/message", {
        message: {
          content: [
            { type: "tool-call", name: "read" },
            { type: "tool-call", id: "x" },
          ],
        },
      })
    )
    expect(events).toEqual([])
  })

  it("treats a turn/end with no reason object as an error", () => {
    const { events } = translateDshNotification(sessionEvent("turn/end", {}))
    expect(events[0]).toMatchObject({ type: "done", success: false })
    expect(events[0]).not.toHaveProperty("stopReason")
  })

  it("treats an event with a non-string type as drift", () => {
    expect(() =>
      translateDshNotification({
        method: "session.event",
        params: { sessionId: "s1", event: { type: 42, seq: 1 } },
      })
    ).toThrow(DshVersionDriftError)
  })

  it("warns when the method is absent entirely", () => {
    const { warnings } = translateDshNotification({ params: { sessionId: "s1" } })
    expect(warnings[0]?.detail).toContain("(none)")
  })
})

describe("translateDshNotifications", () => {
  it("preserves wire order across a batch", () => {
    const { events } = translateDshNotifications([
      sessionEvent("turn/start", {}, 1),
      sessionEvent("assistant/chunk", { chunk: { type: "text-delta", text: "a" } }, 2),
      sessionEvent("turn/end", { reason: { kind: "completed" } }, 3),
    ])
    expect(events.map((e) => e.type)).toEqual(["session_start", "message_delta", "done"])
  })

  it("accumulates warnings across a batch", () => {
    const { warnings } = translateDshNotifications([
      sessionEvent("assistant/chunk", { chunk: { type: "video-delta" } }),
      sessionEvent("assistant/chunk", { chunk: { type: "audio-delta" } }),
    ])
    expect(warnings).toHaveLength(2)
  })
})

describe("version drift", () => {
  it("throws on an unrecognized required event", () => {
    // SESSION_FORMAT_VERSION is 0 with no compatibility promise, so a new
    // required event means the channel no longer matches this codec.
    expect(() => translateDshNotification(sessionEvent("turn/teleport", {}))).toThrow(
      DshVersionDriftError
    )
  })

  it("names the offending event so doctor can report it", () => {
    expect(() => translateDshNotification(sessionEvent("turn/teleport", {}))).toThrow(
      /turn\/teleport/
    )
  })

  it("downgrades an unrecognized event marked ignorable to a warning", () => {
    const notification = {
      method: "session.event",
      params: { sessionId: "s1", event: { type: "telemetry/ping", seq: 9, ignorable: true } },
    }
    const { events, warnings } = translateDshNotification(notification)
    expect(events).toEqual([])
    expect(warnings).toEqual([{ kind: "ignorable-unknown-event", detail: "telemetry/ping" }])
  })

  it("aborts a batch at the drifting event rather than partially translating", () => {
    const batch = [sessionEvent("turn/start", {}), sessionEvent("turn/teleport", {})]
    expect(() => translateDshNotifications(batch)).toThrow(DshVersionDriftError)
  })
})

describe("malformed input", () => {
  it.each([
    ["null", null],
    ["a string", "nope"],
    ["an object without params", { method: "session.event" }],
  ])("warns instead of throwing on %s", (_label, input) => {
    const { events, warnings } = translateDshNotification(input)
    expect(events).toEqual([])
    expect(warnings[0]?.kind).toBe("malformed-payload")
  })

  it("warns on session.event without an event object", () => {
    const { warnings } = translateDshNotification({
      method: "session.event",
      params: { sessionId: "s1" },
    })
    expect(warnings[0]?.kind).toBe("malformed-payload")
  })

  it("warns on an unknown method", () => {
    const { warnings } = translateDshNotification({ method: "session.telepathy", params: {} })
    expect(warnings[0]?.kind).toBe("malformed-payload")
  })
})

describe("dshEventDedupeKey", () => {
  it("separates identical seqs across sessions and channels", () => {
    // Two channels can run concurrently during an upgrade and generate session
    // ids independently.
    const a = dshEventDedupeKey("ch1", "s1", 7)
    expect(a).not.toBe(dshEventDedupeKey("ch1", "s2", 7))
    expect(a).not.toBe(dshEventDedupeKey("ch2", "s1", 7))
    expect(a).toBe(dshEventDedupeKey("ch1", "s1", 7))
  })
})

describe("recorded wire traces", () => {
  const traces = [
    "upstream-bash-tool.notifications.jsonl",
    "upstream-persistent-tools.notifications.jsonl",
    "cognia-sdk-readonly.notifications.jsonl",
  ]

  it.each(traces)("translates %s without version drift", (name) => {
    // The whole point of keeping real traces: the codec must survive upstream's
    // own reference composition, not just hand-written frames.
    expect(() => translateDshNotifications(loadTrace(name))).not.toThrow()
  })

  it.each(traces)("reports no malformed payloads for %s", (name) => {
    const { warnings } = translateDshNotifications(loadTrace(name))
    expect(warnings.filter((w) => w.kind === "malformed-payload")).toEqual([])
  })

  it("pairs every tool result with a preceding tool call in the upstream bash trace", () => {
    const { events } = translateDshNotifications(
      loadTrace("upstream-bash-tool.notifications.jsonl")
    )
    const started = new Set<string>()
    for (const event of events) {
      if (event.type === "tool_use_start") started.add(event.toolUseId)
      if (event.type === "tool_result") expect(started.has(event.toolUseId)).toBe(true)
    }
    expect(started.size).toBeGreaterThan(0)
  })

  it("surfaces the sandbox denial from the Cognia read-only capture", () => {
    // This trace records the model being refused a write and then failing to
    // escalate. If a composition change ever granted the escalation, the error
    // result would disappear and this assertion would fail.
    const { events } = translateDshNotifications(
      loadTrace("cognia-sdk-readonly.notifications.jsonl")
    )
    const errors = events.filter((e) => e.type === "tool_result" && e.isError)
    expect(errors.length).toBeGreaterThan(0)
    const combined = errors
      .map((e) => (e.type === "tool_result" && typeof e.result === "string" ? e.result : ""))
      .join("\n")
    expect(combined).toMatch(/read-only/i)
  })

  it("ends the Cognia capture with a successful turn", () => {
    const { events } = translateDshNotifications(
      loadTrace("cognia-sdk-readonly.notifications.jsonl")
    )
    const done = events.filter((e) => e.type === "done")
    expect(done.at(-1)).toMatchObject({ type: "done", success: true })
  })

  it("emits usage from the Cognia capture", () => {
    const { events } = translateDshNotifications(
      loadTrace("cognia-sdk-readonly.notifications.jsonl")
    )
    const usage = events.filter((e) => e.type === "usage_update")
    expect(usage.length).toBeGreaterThan(0)
    expect(usage.every((e) => e.type === "usage_update" && e.used > 0)).toBe(true)
  })
})
