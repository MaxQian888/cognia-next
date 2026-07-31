/**
 * @jest-environment node
 */
import type {
  ExternalAgentEvent,
  ExternalAgentEventType,
  ExternalAgentPermissionRequestEvent,
} from "@/types/agent/external-agent"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import { createInitialState } from "../../tui/state/initial"
import { tuiReducer } from "../../tui/state/reducer"
import type { TuiAction } from "../../tui/state/types"

import { externalAgentEventToActions } from "./external-event-mapper"

const timestamp = new Date("2026-07-16T00:00:00.000Z")

function event(value: Record<string, unknown>): ExternalAgentEvent {
  return { timestamp, ...value } as ExternalAgentEvent
}

describe("externalAgentEventToActions", () => {
  it.each([
    ["session_start", {}],
    ["session_end", {}],
    ["message_start", {}],
    ["message_end", {}],
    ["content_block_start", {}],
    ["content_block_delta", {}],
    ["content_block_end", {}],
    ["tool_use_delta", { toolUseId: "tool-1", delta: "{}" }],
    ["tool_use_end", { toolUseId: "tool-1", input: {} }],
    ["permission_response", { response: { outcome: { outcome: "cancelled" } } }],
    ["commands_update", { commands: [] }],
    ["config_options_update", { configOptions: [] }],
    ["mode_update", { modeId: "default" }],
    ["progress", { progress: 0.5 }],
  ] satisfies Array<[ExternalAgentEventType, Record<string, unknown>]>)(
    "ignores the %s lifecycle/metadata event",
    (type, payload) => {
      expect(externalAgentEventToActions(event({ type, ...payload }))).toEqual([])
    }
  )

  it("maps text and thinking streams", () => {
    expect(
      externalAgentEventToActions(
        event({ type: "message_delta", delta: { type: "text", text: "hello" } })
      )
    ).toEqual([{ type: "INFLIGHT_TEXT", delta: "hello" }])
    expect(
      externalAgentEventToActions(
        event({ type: "message_delta", delta: { type: "thinking", text: "reason" } })
      )
    ).toEqual([{ type: "INFLIGHT_THINKING", delta: "reason" }])
    expect(externalAgentEventToActions(event({ type: "thinking", thinking: "more" }))).toEqual([
      { type: "INFLIGHT_THINKING", delta: "more" },
    ])
  })

  it("drops empty text and thinking streams", () => {
    expect(
      externalAgentEventToActions(
        event({ type: "message_delta", delta: { type: "text", text: "" } })
      )
    ).toEqual([])
    expect(externalAgentEventToActions(event({ type: "thinking", thinking: "" }))).toEqual([])
  })

  it("maps tool calls and results with the protocol call id", () => {
    expect(
      externalAgentEventToActions(
        event({
          type: "tool_use_start",
          toolUseId: "tool-1",
          toolName: "read",
          rawInput: { path: "README.md" },
        })
      )
    ).toEqual([
      {
        type: "TOOL_CALL",
        callKey: "tool-1",
        toolName: "read",
        input: { path: "README.md" },
      },
    ])
    expect(
      externalAgentEventToActions(
        event({
          type: "tool_result",
          toolUseId: "tool-1",
          toolName: "read",
          rawInput: { path: "README.md" },
          result: "contents",
          isError: true,
        })
      )
    ).toEqual([
      {
        type: "TOOL_RESULT",
        callKey: "tool-1",
        toolName: "read",
        input: { path: "README.md" },
        result: "contents",
        isError: true,
      },
    ])
  })

  it("routes permission requests without creating a TUI action", () => {
    const request = event({
      type: "permission_request",
      request: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", title: "Run command" },
        options: [],
      },
    }) as ExternalAgentPermissionRequestEvent
    const onPermissionRequest = jest.fn()

    expect(externalAgentEventToActions(request, { onPermissionRequest })).toEqual([])
    expect(onPermissionRequest).toHaveBeenCalledWith(request)
  })

  it("maps plan updates to the existing TodoWrite cell contract", () => {
    expect(
      externalAgentEventToActions(
        event({
          type: "plan_update",
          entries: [
            { content: "Inspect", priority: "high", status: "in_progress" },
            { content: "Ship", priority: "low", status: "skipped" },
          ],
          progress: 0.5,
          step: 1,
          totalSteps: 2,
        })
      )
    ).toEqual([
      {
        type: "TOOL_CALL",
        callKey: "external-plan",
        toolName: "TodoWrite",
        input: {
          todos: [
            { content: "Inspect", activeForm: "Inspect", status: "in_progress" },
            { content: "Ship", activeForm: "Ship", status: "completed" },
          ],
        },
      },
    ])
  })

  it("folds ACP diff content into the tool's OWN card instead of synthesizing a second one", () => {
    expect(
      externalAgentEventToActions(
        event({
          type: "tool_call_update",
          toolCallId: "tool-1",
          content: [
            { type: "content", content: { type: "text", text: "editing" } },
            { type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" },
          ],
        })
      )
    ).toEqual([
      {
        type: "TOOL_UPDATE",
        callKey: "tool-1",
        toolName: "Edit",
        input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" },
      },
    ])
  })

  it("reads a file creation as a Write, not an Edit against empty text", () => {
    expect(
      externalAgentEventToActions(
        event({
          type: "tool_call_update",
          toolCallId: "tool-1",
          content: [{ type: "diff", path: "/work/new.ts", newText: "hello" }],
        })
      )
    ).toEqual([
      {
        type: "TOOL_UPDATE",
        callKey: "tool-1",
        toolName: "Write",
        input: { file_path: "/work/new.ts", content: "hello" },
      },
    ])
  })

  it("keeps every hunk of a multi-diff call on one MultiEdit card", () => {
    expect(
      externalAgentEventToActions(
        event({
          type: "tool_call_update",
          toolCallId: "tool-1",
          content: [
            { type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" },
            { type: "diff", path: "/work/a.ts", oldText: "c", newText: "d" },
          ],
        })
      )
    ).toEqual([
      {
        type: "TOOL_UPDATE",
        callKey: "tool-1",
        toolName: "MultiEdit",
        input: {
          file_path: "/work/a.ts",
          edits: [
            { old_string: "a", new_string: "b" },
            { old_string: "c", new_string: "d" },
          ],
        },
      },
    ])
  })

  it("omits a shared path when the hunks disagree about the file", () => {
    const [action] = externalAgentEventToActions(
      event({
        type: "tool_call_update",
        toolCallId: "tool-1",
        content: [
          { type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" },
          { type: "diff", path: "/work/b.ts", oldText: "c", newText: "d" },
        ],
      })
    )
    expect(action.type).toBe("TOOL_UPDATE")
    if (action.type === "TOOL_UPDATE") expect(action.input).not.toHaveProperty("file_path")
  })

  it("derives a canonical tool name from the ACP kind and keeps the title as a label", () => {
    expect(
      externalAgentEventToActions(
        event({
          type: "tool_use_start",
          toolUseId: "tool-1",
          toolName: "Reading configuration file",
          kind: "read",
          locations: [{ path: "/work/cognia.json" }],
        })
      )
    ).toEqual([
      {
        type: "TOOL_CALL",
        callKey: "tool-1",
        // Free-form prose used to land here, silently disabling every formatter
        // that dispatches on a tool name.
        toolName: "Read",
        displayTitle: "Reading configuration file",
        // …and the structured location fills in the path the card links to.
        input: { file_path: "/work/cognia.json" },
      },
    ])
  })

  it("keeps the protocol title as the tool name when no canonical mapping is safe", () => {
    expect(
      externalAgentEventToActions(
        event({
          type: "tool_use_start",
          toolUseId: "tool-1",
          toolName: "search_docs",
          kind: "mcp",
          rawInput: { query: "acp" },
        })
      )
    ).toEqual([
      { type: "TOOL_CALL", callKey: "tool-1", toolName: "search_docs", input: { query: "acp" } },
    ])
  })

  it("never overwrites a path the tool supplied itself", () => {
    const [action] = externalAgentEventToActions(
      event({
        type: "tool_use_start",
        toolUseId: "tool-1",
        toolName: "Read",
        kind: "read",
        rawInput: { file_path: "/work/explicit.ts" },
        locations: [{ path: "/work/other.ts" }],
      })
    )
    if (action.type === "TOOL_CALL") expect(action.input.file_path).toBe("/work/explicit.ts")
  })

  it("does not stack duplicate cards when the protocol re-sends the same diff", () => {
    const update = event({
      type: "tool_call_update",
      toolCallId: "t",
      content: [{ type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" }],
    })
    let state = createInitialState({ ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }, "session-1")
    state = tuiReducer(state, { type: "TURN_START", prompt: "edit" })
    state = externalAgentEventToActions(
      event({ type: "tool_use_start", toolUseId: "t", toolName: "Edit file", kind: "file_write" })
    ).reduce(tuiReducer, state)

    // ACP emits an update on every non-terminal status change, re-sending content.
    for (let i = 0; i < 3; i++) {
      state = externalAgentEventToActions(update).reduce(tuiReducer, state)
    }

    const tools = state.inflight.tools
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      toolName: "Edit",
      displayTitle: "Edit file",
      input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" },
    })
  })

  it("labels a nameless tool result rather than dropping it", () => {
    expect(
      externalAgentEventToActions(event({ type: "tool_result", toolUseId: "t1", result: "done" }))
    ).toEqual([{ type: "TOOL_RESULT", callKey: "t1", toolName: "external", result: "done" }])
  })

  it("ignores an update that carries no content at all", () => {
    expect(
      externalAgentEventToActions(event({ type: "tool_call_update", toolCallId: "t1" }))
    ).toEqual([])
    expect(
      externalAgentEventToActions(
        event({
          type: "tool_call_update",
          toolCallId: "t1",
          content: [{ type: "content", content: { type: "text", text: "no diff here" } }],
        })
      )
    ).toEqual([])
  })

  it("carries the update's own title onto the card", () => {
    const [action] = externalAgentEventToActions(
      event({
        type: "tool_call_update",
        toolCallId: "t1",
        title: "Applying patch",
        content: [{ type: "diff", path: "/a.ts", oldText: "a", newText: "b" }],
      })
    )
    if (action.type === "TOOL_UPDATE") expect(action.displayTitle).toBe("Applying patch")
  })

  it("treats a hunk with no prior text as an insertion inside a MultiEdit", () => {
    const [action] = externalAgentEventToActions(
      event({
        type: "tool_call_update",
        toolCallId: "t1",
        content: [
          { type: "diff", path: "/a.ts", oldText: "a", newText: "b" },
          { type: "diff", path: "/a.ts", newText: "appended" },
        ],
      })
    )
    if (action.type === "TOOL_UPDATE") {
      expect(action.input).toMatchObject({
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "", new_string: "appended" },
        ],
      })
    }
  })

  it("summarises a hook fire from whichever field carries the detail", () => {
    expect(
      externalAgentEventToActions(
        event({ type: "hook_fire", event: "PreToolUse", outcome: "warning", warnings: ["slow"] })
      )
    ).toEqual([{ type: "NOTICE", message: "PreToolUse warning: slow" }])

    expect(
      externalAgentEventToActions(
        event({ type: "hook_fire", event: "Stop", outcome: "context", warnings: [] })
      )
    ).toEqual([{ type: "NOTICE", message: "Stop context" }])
  })

  it("keeps a recoverable error as a warning notice rather than ending the turn", () => {
    expect(
      externalAgentEventToActions(
        event({ type: "error", error: "retrying", code: "E_RETRY", recoverable: true })
      )
    ).toEqual([{ type: "NOTICE", message: "E_RETRY: retrying", severity: "warn" }])

    expect(
      externalAgentEventToActions(event({ type: "error", error: "hiccup", recoverable: true }))
    ).toEqual([{ type: "NOTICE", message: "hiccup", severity: "warn" }])
  })

  it("maps terminal errors and consequential hooks", () => {
    expect(
      externalAgentEventToActions(
        event({ type: "error", error: "agent failed", code: "E_AGENT", recoverable: false })
      )
    ).toEqual([
      {
        type: "TURN_ERROR",
        message: "agent failed",
        category: "E_AGENT",
        title: "External agent error",
      },
    ])
    expect(
      externalAgentEventToActions(
        event({
          type: "hook_fire",
          event: "PreToolUse",
          outcome: "blocked",
          block: "Policy denied it",
          warnings: [],
        })
      )
    ).toEqual([{ type: "NOTICE", message: "PreToolUse blocked: Policy denied it" }])
  })

  it("maps authoritative done usage and ignores a done event without usage", () => {
    expect(
      externalAgentEventToActions(
        event({
          type: "done",
          success: true,
          tokenUsage: {
            promptTokens: 12,
            completionTokens: 5,
            totalTokens: 17,
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
            reasoningTokens: 1,
            contextTokens: 17,
            modelContextWindow: 272_000,
          },
        })
      )
    ).toEqual([
      {
        type: "SET_USAGE",
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          reasoningTokens: 1,
          contextTokens: 17,
          contextWindow: 272_000,
        },
      },
    ])
    expect(externalAgentEventToActions(event({ type: "done", success: true }))).toEqual([])
  })

  it("golden-reduces a scripted ACP turn into assistant, todo, and diff cells", () => {
    const permission = jest.fn()
    const events = [
      event({ type: "message_delta", delta: { type: "thinking", text: "Checking" } }),
      event({ type: "message_delta", delta: { type: "text", text: "I will update it." } }),
      event({
        type: "plan_update",
        entries: [{ content: "Edit file", priority: "high", status: "in_progress" }],
        progress: 0,
        step: 1,
        totalSteps: 1,
      }),
      event({
        type: "permission_request",
        request: { sessionId: "s", toolCall: { toolCallId: "t", title: "Edit" }, options: [] },
      }),
      event({
        type: "tool_call_update",
        toolCallId: "t",
        content: [{ type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" }],
      }),
      // ACP reports completion as a terminal tool_call_update, which the shared
      // client surfaces as a tool_result — that, not a synthesized card, is what
      // resolves the ⏳.
      event({ type: "tool_result", toolUseId: "t", toolName: "Edit", result: "applied" }),
      event({
        type: "done",
        success: true,
        tokenUsage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      }),
    ]
    let state = createInitialState({ ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }, "session-1")
    state = tuiReducer(state, { type: "TURN_START", prompt: "Update a.ts" })
    for (const item of events) {
      const actions = externalAgentEventToActions(item, { onPermissionRequest: permission })
      state = actions.reduce(tuiReducer, state)
    }
    state = tuiReducer(state, {
      type: "TURN_COMMIT",
      result: {
        text: "I will update it.",
        messageId: "external-1",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      },
    })

    expect(permission).toHaveBeenCalledTimes(1)
    expect(
      state.cells.map((cell) =>
        cell.kind === "tool"
          ? { kind: cell.kind, toolName: cell.toolName, status: cell.status }
          : { kind: cell.kind }
      )
    ).toEqual([
      { kind: "user" },
      { kind: "thinking" },
      { kind: "assistant" },
      { kind: "todo" },
      { kind: "tool", toolName: "Edit", status: "done" },
    ])
    expect(state.usage).toEqual({ inputTokens: 4, outputTokens: 2 })
  })

  it("reduces an error event into an error cell", () => {
    let state = createInitialState({ ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }, "session-1")
    state = tuiReducer(state, { type: "TURN_START", prompt: "fail" })
    const actions: TuiAction[] = externalAgentEventToActions(
      event({ type: "error", error: "boom", recoverable: false })
    )
    state = actions.reduce(tuiReducer, state)
    expect(state.cells.at(-1)).toMatchObject({ kind: "error", message: "boom" })
  })
})
