import { applyExternalAgentEventToParts, buildPartsFromExternalAgentEvents } from "./event-to-parts"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"

const at = (millis = 0): Date => new Date(millis)

const ev = (overrides: Partial<ExternalAgentEvent>): ExternalAgentEvent =>
  ({ timestamp: at(), ...overrides }) as ExternalAgentEvent

describe("applyExternalAgentEventToParts — text deltas", () => {
  it("creates a text part on the first delta and concatenates further deltas", () => {
    let parts = applyExternalAgentEventToParts(
      [],
      ev({ type: "message_delta", delta: { type: "text", text: "Hello" } })
    )
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: "text", text: "Hello", state: "done" })

    parts = applyExternalAgentEventToParts(
      parts,
      ev({ type: "message_delta", delta: { type: "text", text: ", world" } })
    )
    expect(parts).toHaveLength(1)
    expect((parts[0] as { text: string }).text).toBe("Hello, world")
  })

  it("ignores empty text deltas without creating placeholder parts", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({ type: "message_delta", delta: { type: "text", text: "" } })
    )
    expect(parts).toEqual([])
  })
})

describe("applyExternalAgentEventToParts — reasoning", () => {
  it("routes thinking events to a reasoning part", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({ type: "thinking", thinking: "Let me think…" })
    )
    expect(parts[0]).toMatchObject({ type: "reasoning", text: "Let me think…" })
  })

  it("routes message_delta with type=thinking to the same reasoning part", () => {
    let parts = applyExternalAgentEventToParts([], ev({ type: "thinking", thinking: "A" }))
    parts = applyExternalAgentEventToParts(
      parts,
      ev({ type: "message_delta", delta: { type: "thinking", text: "B" } })
    )
    expect(parts).toHaveLength(1)
    expect((parts[0] as { text: string }).text).toBe("AB")
  })
})

describe("applyExternalAgentEventToParts — commentary", () => {
  it("keeps commentary distinct from reasoning and seals it on completion", () => {
    let parts = applyExternalAgentEventToParts(
      [],
      ev({
        type: "commentary_delta",
        messageId: "commentary-1",
        text: "Checking ",
        done: false,
        source: "codex",
      })
    )
    parts = applyExternalAgentEventToParts(
      parts,
      ev({
        type: "commentary_delta",
        messageId: "commentary-1",
        text: "the tests",
        done: false,
        source: "codex",
      })
    )
    parts = applyExternalAgentEventToParts(
      parts,
      ev({
        type: "commentary_delta",
        messageId: "commentary-1",
        text: "",
        done: true,
        source: "codex",
      })
    )

    expect(parts).toEqual([
      {
        type: "data-commentary",
        data: {
          messageId: "commentary-1",
          text: "Checking the tests",
          state: "done",
          source: "codex",
        },
      },
    ])
    expect(parts.some((part) => (part as { type: string }).type === "reasoning")).toBe(false)
  })
})

describe("applyExternalAgentEventToParts — tool calls", () => {
  it("creates a tool-<name> part on tool_use_start in `input-available` state", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "Read",
        rawInput: { path: "a.ts" },
      })
    )
    expect(parts[0]).toMatchObject({
      type: "tool-Read",
      toolCallId: "t1",
      state: "input-available",
      input: { path: "a.ts" },
    })
  })

  it("preserves a display title and semantic metadata on tool_use_start", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "calendar.create_event",
        title: "Calendar · Create event",
        rawInput: { date: "2026-08-07" },
        toolMetadata: {
          kind: "mcp",
          readOnlyHint: false,
          appContext: { appName: "Calendar", actionName: "create_event" },
        },
      })
    )

    expect(parts[0]).toMatchObject({
      type: "tool-calendar.create_event",
      toolCallId: "t1",
      title: "Calendar · Create event",
      toolMetadata: {
        kind: "mcp",
        readOnlyHint: false,
        appContext: { appName: "Calendar", actionName: "create_event" },
      },
    })
  })

  it("updates a repeated tool_use_start in place when a later OpenCode state adds a title", () => {
    const started = applyExternalAgentEventToParts(
      [],
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "read",
        rawInput: { path: "a.ts" },
      })
    )
    const updated = applyExternalAgentEventToParts(
      started,
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "read",
        title: "Reading a.ts",
        rawInput: { path: "a.ts", offset: 20 },
      })
    )

    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      type: "tool-read",
      toolCallId: "t1",
      title: "Reading a.ts",
      input: { path: "a.ts", offset: 20 },
    })
  })

  it("updates a tool title and metadata without changing its identity or losing output", () => {
    const started = applyExternalAgentEventToParts(
      [],
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "Read",
        title: "Reading file",
        rawInput: { path: "a.ts" },
      })
    )
    const completed = applyExternalAgentEventToParts(
      started,
      ev({ type: "tool_result", toolUseId: "t1", result: "contents" })
    )
    const updated = applyExternalAgentEventToParts(
      completed,
      ev({
        type: "tool_call_update",
        toolCallId: "t1",
        title: "Read a.ts",
        kind: "read",
        rawInput: { path: "a.ts", line: 12 },
        locations: [{ path: "a.ts", line: 12 }],
      })
    )

    expect(updated[0]).toMatchObject({
      type: "tool-Read",
      toolCallId: "t1",
      title: "Read a.ts",
      state: "output-available",
      input: { path: "a.ts", line: 12 },
      output: "contents",
      toolMetadata: {
        kind: "read",
        locations: [{ path: "a.ts", line: 12 }],
      },
    })
  })

  it("patches the matching tool part on tool_use_end", () => {
    const start = applyExternalAgentEventToParts(
      [],
      ev({ type: "tool_use_start", toolUseId: "t1", toolName: "Read", rawInput: {} })
    )
    const end = applyExternalAgentEventToParts(
      start,
      ev({ type: "tool_use_end", toolUseId: "t1", input: { path: "b.ts" } })
    )
    expect(end[0]).toMatchObject({ type: "tool-Read", input: { path: "b.ts" } })
  })

  it("transitions to output-available on tool_result success", () => {
    const events: ExternalAgentEvent[] = [
      ev({ type: "tool_use_start", toolUseId: "t1", toolName: "Read", rawInput: {} }),
      ev({ type: "tool_result", toolUseId: "t1", result: "file contents" }),
    ]
    const parts = buildPartsFromExternalAgentEvents(events)
    expect(parts[0]).toMatchObject({
      type: "tool-Read",
      state: "output-available",
      output: "file contents",
    })
  })

  it("transitions to output-error and stores errorText when tool_result is error", () => {
    const events: ExternalAgentEvent[] = [
      ev({ type: "tool_use_start", toolUseId: "t1", toolName: "Bash", rawInput: {} }),
      ev({ type: "tool_result", toolUseId: "t1", result: "boom", isError: true }),
    ]
    const parts = buildPartsFromExternalAgentEvents(events)
    expect(parts[0]).toMatchObject({
      type: "tool-Bash",
      state: "output-error",
      errorText: "boom",
    })
  })

  it("ignores tool_result with no matching tool_use_start", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({ type: "tool_result", toolUseId: "ghost", result: "x" })
    )
    expect(parts).toEqual([])
  })
})

describe("applyExternalAgentEventToParts — artifacts", () => {
  it("emits an ArtifactPart instead of a tool part for artifact_create", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "artifact_create",
        rawInput: { id: "art-1", title: "demo", type: "document" },
      })
    )
    expect(parts[0]).toMatchObject({
      type: "artifact",
      artifactId: "art-1",
      title: "demo",
      kind: "document",
    })
  })

  it("falls back to tool-artifact_create when input is missing required fields", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "artifact_create",
        rawInput: { title: "no-id" },
      })
    )
    expect(parts[0]).toMatchObject({ type: "tool-artifact_create" })
  })

  it("normalises unknown artifact kinds to `code`", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "artifact_update",
        rawInput: { id: "x", title: "y", kind: "totally-new-kind" },
      })
    )
    expect((parts[0] as unknown as { kind: string }).kind).toBe("code")
  })
})

describe("buildPartsFromExternalAgentEvents — integration", () => {
  it("produces a coherent assistant turn from a realistic event stream", () => {
    const events: ExternalAgentEvent[] = [
      ev({ type: "message_start" }),
      ev({ type: "thinking", thinking: "Plan: read file then summarise" }),
      ev({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "Read",
        rawInput: { path: "README.md" },
      }),
      ev({
        type: "tool_result",
        toolUseId: "t1",
        result: "# Hello",
      }),
      ev({ type: "message_delta", delta: { type: "text", text: "Here is" } }),
      ev({ type: "message_delta", delta: { type: "text", text: " the readme." } }),
      ev({ type: "message_end" }),
    ]
    const parts = buildPartsFromExternalAgentEvents(events)
    expect(parts.map((p) => (p as { type: string }).type)).toEqual([
      "reasoning",
      "tool-Read",
      "text",
    ])
    expect((parts[2] as { text: string }).text).toBe("Here is the readme.")
  })

  it("ignores permission_request / plan_update / commands_update / unknown events", () => {
    const events: ExternalAgentEvent[] = [
      ev({ type: "permission_request" } as unknown as ExternalAgentEvent),
      ev({ type: "plan_update" } as unknown as ExternalAgentEvent),
      ev({ type: "commands_update" } as unknown as ExternalAgentEvent),
      ev({ type: "progress" } as unknown as ExternalAgentEvent),
    ]
    expect(buildPartsFromExternalAgentEvents(events)).toEqual([])
  })
})

describe("applyExternalAgentEventToParts — hook_fire", () => {
  it("appends an inline hook-notice part carrying the decision", () => {
    const parts = applyExternalAgentEventToParts(
      [],
      ev({
        type: "hook_fire",
        event: "PreToolUse",
        toolName: "Bash",
        outcome: "blocked",
        block: "command matches denylist",
        warnings: ["hook timed out after 5000ms"],
      } as unknown as ExternalAgentEvent)
    )
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: "hook-notice",
      event: "PreToolUse",
      toolName: "Bash",
      outcome: "blocked",
      block: "command matches denylist",
      warnings: ["hook timed out after 5000ms"],
    })
  })

  it("defaults warnings to [] and sits after the preceding tool part", () => {
    const events: ExternalAgentEvent[] = [
      ev({ type: "tool_use_start", toolUseId: "t1", toolName: "Bash", rawInput: {} }),
      ev({
        type: "hook_fire",
        event: "PostToolUse",
        outcome: "context",
        additionalContext: "loaded ctx",
      } as unknown as ExternalAgentEvent),
    ]
    const parts = buildPartsFromExternalAgentEvents(events)
    expect(parts.map((p) => (p as { type: string }).type)).toEqual(["tool-Bash", "hook-notice"])
    expect(parts[1]).toMatchObject({ outcome: "context", warnings: [] })
  })
})
