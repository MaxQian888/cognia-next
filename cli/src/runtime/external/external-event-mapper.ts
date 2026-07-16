import type {
  AcpPlanEntry,
  AcpToolCallDiffContent,
  ExternalAgentDoneEvent,
  ExternalAgentErrorEvent,
  ExternalAgentEvent,
  ExternalAgentHookFireEvent,
  ExternalAgentPermissionRequestEvent,
  ExternalAgentPlanUpdateEvent,
  ExternalAgentTokenUsage,
  ExternalAgentToolCallUpdateEvent,
  ExternalAgentToolResultEvent,
  ExternalAgentToolUseStartEvent,
} from "@/types/agent/external-agent"

import type { TuiAction } from "../../tui/state/types"

export interface ExternalEventMapperOptions {
  onPermissionRequest?: (event: ExternalAgentPermissionRequestEvent) => void
}

/** Translate one protocol event into the existing TUI reducer vocabulary. */
export function externalAgentEventToActions(
  event: ExternalAgentEvent,
  options: ExternalEventMapperOptions = {}
): TuiAction[] {
  switch (event.type) {
    case "message_delta":
      if (!event.delta.text) return []
      return [
        event.delta.type === "thinking"
          ? { type: "INFLIGHT_THINKING", delta: event.delta.text }
          : { type: "INFLIGHT_TEXT", delta: event.delta.text },
      ]
    case "thinking":
      return event.thinking ? [{ type: "INFLIGHT_THINKING", delta: event.thinking }] : []
    case "tool_use_start":
      return toolStartActions(event)
    case "tool_result":
      return toolResultActions(event)
    case "tool_call_update":
      return diffActions(event)
    case "permission_request":
      options.onPermissionRequest?.(event)
      return []
    case "plan_update":
      return planActions(event)
    case "error":
      return errorActions(event)
    case "done":
      return usageActions(event)
    case "hook_fire":
      return hookActions(event)
    default:
      return []
  }
}

function toolStartActions(event: ExternalAgentToolUseStartEvent): TuiAction[] {
  return [
    {
      type: "TOOL_CALL",
      callKey: event.toolUseId,
      toolName: event.toolName,
      input: event.rawInput ?? {},
    },
  ]
}

function toolResultActions(event: ExternalAgentToolResultEvent): TuiAction[] {
  return [
    {
      type: "TOOL_RESULT",
      callKey: event.toolUseId,
      toolName: event.toolName ?? "external",
      ...(event.rawInput ? { input: event.rawInput } : {}),
      result: event.result,
      ...(event.isError ? { isError: true } : {}),
    },
  ]
}

function planActions(event: ExternalAgentPlanUpdateEvent): TuiAction[] {
  return [
    {
      type: "TOOL_CALL",
      callKey: "external-plan",
      toolName: "TodoWrite",
      input: { todos: event.entries.map(planEntryToTodo) },
    },
  ]
}

function planEntryToTodo(entry: AcpPlanEntry): Record<string, string> {
  const status = entry.status === "skipped" ? "completed" : entry.status
  return { content: entry.content, activeForm: entry.content, status }
}

function diffActions(event: ExternalAgentToolCallUpdateEvent): TuiAction[] {
  const diffs = (event.content ?? []).filter(
    (content): content is AcpToolCallDiffContent => content.type === "diff"
  )
  return diffs.flatMap((diff, index) => {
    const callKey = `${event.toolCallId}:diff:${index}`
    const input = {
      file_path: diff.path,
      old_string: diff.oldText ?? "",
      new_string: diff.newText,
    }
    return [
      { type: "TOOL_CALL", callKey, toolName: "Edit", input },
      {
        type: "TOOL_RESULT",
        callKey,
        toolName: "Edit",
        input,
        result: { path: diff.path, oldText: diff.oldText, newText: diff.newText },
      },
    ] satisfies TuiAction[]
  })
}

function errorActions(event: ExternalAgentErrorEvent): TuiAction[] {
  if (event.recoverable) {
    return [
      {
        type: "NOTICE",
        message: event.code ? `${event.code}: ${event.error}` : event.error,
        severity: "warn",
      },
    ]
  }
  return [
    {
      type: "TURN_ERROR",
      message: event.error,
      ...(event.code ? { category: event.code } : {}),
      title: "External agent error",
    },
  ]
}

function usageActions(event: ExternalAgentDoneEvent): TuiAction[] {
  return event.tokenUsage
    ? [{ type: "SET_USAGE", usage: tokenUsageToUsageInfo(event.tokenUsage) }]
    : []
}

function tokenUsageToUsageInfo(usage: ExternalAgentTokenUsage) {
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadInputTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheCreationInputTokens: usage.cacheWriteTokens }),
  }
}

function hookActions(event: ExternalAgentHookFireEvent): TuiAction[] {
  const detail =
    event.block ?? event.additionalContext ?? event.warnings.find((warning) => warning.length > 0)
  const prefix = `${event.event} ${event.outcome}`
  return [{ type: "NOTICE", message: detail ? `${prefix}: ${detail}` : prefix }]
}
