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

  it("maps ACP diff content to completed Edit tool cards", () => {
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
        type: "TOOL_CALL",
        callKey: "tool-1:diff:0",
        toolName: "Edit",
        input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" },
      },
      {
        type: "TOOL_RESULT",
        callKey: "tool-1:diff:0",
        toolName: "Edit",
        input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" },
        result: { path: "/work/a.ts", oldText: "a", newText: "b" },
      },
    ])
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
