import type {
  AcpPlanEntry,
  AcpToolCallDiffContent,
  AcpToolCallKind,
  AcpToolCallLocation,
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
import type { CanonicalAgentEvent } from "@cognia/agent-config-types/agent-execution"

export interface ExternalEventMapperOptions {
  onPermissionRequest?: (event: ExternalAgentPermissionRequestEvent) => void
}

/** Preserve protocol events that do not have a legacy reducer action. The
 * canonical stream is the audit-complete path; legacy consumers keep their
 * historical projections through {@link externalAgentEventToActions}. */
export function externalAgentEventToCanonicalFallback(
  event: ExternalAgentEvent
): CanonicalAgentEvent {
  switch (event.type) {
    case "session_start":
      return { kind: "lifecycle", phase: "started", detail: "External agent session started" }
    case "session_end":
      return {
        kind: "lifecycle",
        phase: event.reason === "cancelled" ? "interrupted" : "ended",
        ...(event.error ? { detail: event.error } : {}),
      }
    case "message_start":
      return { kind: "activity", phase: "requesting", detail: "External agent is responding" }
    case "message_delta":
      return event.delta.type === "thinking"
        ? { kind: "thinking-delta", delta: event.delta.text }
        : { kind: "text-delta", delta: event.delta.text }
    case "message_end":
      return { kind: "activity", phase: "idle" }
    case "thinking":
      return { kind: "thinking-delta", delta: event.thinking }
    case "commentary_delta":
      return {
        kind: "commentary-delta",
        delta: event.text,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(typeof event.done === "boolean" ? { done: event.done } : {}),
      }
    case "tool_use_delta":
      return {
        kind: "tool-progress",
        toolCallId: event.toolUseId,
        toolName: "external",
        elapsedMs: 0,
      }
    case "tool_use_end":
      return {
        kind: "informational",
        content: `External tool input completed: ${event.toolUseId}`,
        level: "info",
      }
    case "permission_request":
      return {
        kind: "permission-request",
        requestId: event.request.requestId ?? event.request.id,
        toolName: event.request.toolInfo.name,
        ...(event.request.rawInput ? { input: event.request.rawInput } : {}),
      }
    case "permission_response":
      return {
        kind: "permission-resolved",
        requestId: event.response.requestId,
        behavior: event.response.granted ? "allow" : "deny",
      }
    case "elicitation_request":
      return {
        kind: "elicitation-request",
        requestId: event.request.id,
        source: event.request.origin ?? "external-agent",
        prompt: event.request.message,
        ...(event.request.requestedSchema
          ? { schema: event.request.requestedSchema as unknown as Record<string, unknown> }
          : {}),
      }
    case "elicitation_complete":
      return { kind: "elicitation-resolved", requestId: event.elicitationId, outcome: "answered" }
    case "commands_update":
      return {
        kind: "commands-changed",
        commands: event.commands.map((command) => ({
          name: command.name,
          ...(command.description ? { description: command.description } : {}),
          source: "external-agent",
        })),
      }
    case "config_options_update":
      return {
        kind: "informational",
        content: `${event.configOptions.length} external configuration options available`,
        level: "info",
      }
    case "mode_update":
      return { kind: "informational", content: `External mode: ${event.modeId}`, level: "notice" }
    case "usage_update":
      return {
        kind: "usage",
        partial: true,
        usage: {
          contextTokens: event.used,
          contextWindow: event.size,
          ...(event.cost ? { cost: event.cost } : {}),
        },
      }
    case "session_info_update":
      return {
        kind: "informational",
        content: event.title
          ? `Session title: ${event.title}`
          : "External session metadata updated",
        level: "info",
      }
    case "progress":
      return {
        kind: "activity",
        phase: "requesting",
        detail: event.message ?? `Progress ${Math.round(event.progress * 100)}%`,
      }
    case "done":
      return {
        kind: "lifecycle",
        phase: event.success ? "ended" : "interrupted",
        ...(event.stopReason ? { detail: event.stopReason } : {}),
      }
    case "error":
      return {
        kind: "failure",
        code: event.code ?? "external_agent",
        message: event.error,
        retryable: event.recoverable ?? false,
      }
    default:
      return {
        kind: "informational",
        content: `External event: ${event.type}`,
        level: "info",
      }
  }
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

/**
 * ACP tool kinds that map to a canonical CLI tool name with confidence.
 *
 * The protocol's `title` is free-form prose ("Reading configuration file"), but
 * every TUI formatter — diff rendering, clickable file paths, the namespace
 * badge — dispatches on a canonical tool name. Using the title as the tool name
 * silently disabled all of them. `kind` is the structured field that survives
 * upstream rewording, so it drives the mapping and the title becomes a label.
 *
 * Deliberately partial: kinds whose canonical equivalent would be a guess
 * (`mcp`, `browser`, `switch_mode`, `other`) keep falling back to the title
 * rather than inventing a tool name a formatter would then misread.
 */
const CANONICAL_BY_KIND: Partial<Record<AcpToolCallKind, string>> = {
  read: "Read",
  file_read: "Read",
  write: "Write",
  file_write: "Write",
  execute: "Bash",
  terminal: "Bash",
}

function canonicalToolName(kind: AcpToolCallKind | undefined, title: string): string {
  return (kind && CANONICAL_BY_KIND[kind]) || title
}

/** Input keys the tool formatters read a file path out of. */
const FILE_PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"]

/**
 * Fold the protocol's structured `locations` into the tool input when the raw
 * input carries no path of its own, so the card can still show — and link — the
 * file it acts on.
 */
function withLocation(
  input: Record<string, unknown>,
  locations: AcpToolCallLocation[] | undefined
): Record<string, unknown> {
  const path = locations?.[0]?.path
  if (!path) return input
  if (FILE_PATH_KEYS.some((key) => typeof input[key] === "string" && input[key])) return input
  return { ...input, file_path: path }
}

function toolStartActions(event: ExternalAgentToolUseStartEvent): TuiAction[] {
  const toolName = canonicalToolName(event.kind, event.toolName)
  return [
    {
      type: "TOOL_CALL",
      callKey: event.toolUseId,
      toolName,
      input: withLocation(event.rawInput ?? {}, event.locations),
      ...(toolName === event.toolName ? {} : { displayTitle: event.toolName }),
    },
  ]
}

function toolResultActions(event: ExternalAgentToolResultEvent): TuiAction[] {
  const title = event.toolName ?? "external"
  return [
    {
      type: "TOOL_RESULT",
      callKey: event.toolUseId,
      toolName: canonicalToolName(event.kind, title),
      ...(event.rawInput ? { input: withLocation(event.rawInput, event.locations) } : {}),
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

/**
 * Fold a tool call's diff content INTO its own card.
 *
 * This used to synthesize a second `Edit` card per diff, so one edit rendered as
 * two rows — a prose-titled card with no diff, plus a diff card — and because
 * the protocol re-sends content on every non-terminal status change, and the
 * synthesized pair completed immediately, each re-send stacked another copy.
 * A single idempotent update keyed on the real `toolCallId` fixes both: the
 * card is refined in place, and a repeated update just re-merges the same
 * values.
 */
function diffActions(event: ExternalAgentToolCallUpdateEvent): TuiAction[] {
  const diffs = (event.content ?? []).filter(
    (content): content is AcpToolCallDiffContent => content.type === "diff"
  )
  if (diffs.length === 0) return []
  return [
    {
      type: "TOOL_UPDATE",
      callKey: event.toolCallId,
      ...diffToolPayload(diffs),
      ...(event.title ? { displayTitle: event.title } : {}),
    },
  ]
}

/**
 * The canonical name + input for a set of diffs.
 *
 * A single diff is an `Edit` (or a `Write` when there is no prior text, which is
 * what a file creation looks like); several become a `MultiEdit`, whose existing
 * renderer already walks an `edits` array — so nothing is dropped when one tool
 * call touches more than one hunk. The shared `file_path` is only set when every
 * diff agrees on it, so a multi-file call never displays a path that is wrong
 * for most of its content.
 */
function diffToolPayload(diffs: AcpToolCallDiffContent[]): {
  toolName: string
  input: Record<string, unknown>
} {
  const paths = new Set(diffs.map((diff) => diff.path))
  const sharedPath = paths.size === 1 ? diffs[0].path : undefined
  if (diffs.length === 1) {
    const [diff] = diffs
    return diff.oldText
      ? {
          toolName: "Edit",
          input: { file_path: diff.path, old_string: diff.oldText, new_string: diff.newText },
        }
      : { toolName: "Write", input: { file_path: diff.path, content: diff.newText } }
  }
  return {
    toolName: "MultiEdit",
    input: {
      ...(sharedPath ? { file_path: sharedPath } : {}),
      edits: diffs.map((diff) => ({
        old_string: diff.oldText ?? "",
        new_string: diff.newText,
      })),
    },
  }
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
    ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
    ...(usage.modelContextWindow === undefined ? {} : { contextWindow: usage.modelContextWindow }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
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
