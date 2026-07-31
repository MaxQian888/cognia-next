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
