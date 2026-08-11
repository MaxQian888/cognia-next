/**
 * Translates a `CaptureStreamEvent` (from `runAndCaptureAssistantReply`'s
 * `onEvent` seam) into reducer actions. Kept pure so the wiring is unit-tested
 * without a live session.
 */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import {
  isKnownCanonicalAgentEventKind,
  type AgentEventEnvelope,
  type CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"

import type { TuiAction } from "./types"
import { validateContentPart } from "../render/content-part-policy"

export type CanonicalTuiClassification = "transcript" | "status" | "interactive" | "audit"

/**
 * Explicit routing table for the complete schema-v1 vocabulary. Keeping this
 * as a typed record makes adding a canonical event a compile-time TUI task.
 */
export const CANONICAL_TUI_CLASSIFICATION = {
  lifecycle: "status",
  "user-input": "transcript",
  "text-delta": "transcript",
  "thinking-delta": "transcript",
  "commentary-delta": "transcript",
  "content-part": "transcript",
  "tool-call": "transcript",
  "tool-result": "transcript",
  "permission-request": "interactive",
  "permission-resolved": "interactive",
  subagent: "status",
  usage: "status",
  compact: "transcript",
  checkpoint: "transcript",
  "elicitation-request": "interactive",
  "elicitation-resolved": "interactive",
  retry: "status",
  queue: "status",
  resource: "audit",
  "session-init": "audit",
  activity: "status",
  "session-state": "status",
  hook: "audit",
  "tool-progress": "status",
  "tool-summary": "transcript",
  auth: "status",
  task: "status",
  "task-inventory": "status",
  notification: "status",
  informational: "transcript",
  "commands-changed": "audit",
  "memory-recall": "audit",
  "files-persisted": "audit",
  "model-refusal": "transcript",
  "local-command-output": "transcript",
  "control-progress": "status",
  "prompt-suggestion": "interactive",
  "conversation-reset": "transcript",
  "rate-limit": "status",
  "worker-shutdown": "audit",
  "mirror-error": "audit",
  "plugin-install": "interactive",
  "user-replay": "audit",
  "structured-output": "transcript",
  warning: "transcript",
  failure: "transcript",
  "capability-error": "transcript",
  diagnostic: "audit",
} as const satisfies Record<CanonicalAgentEvent["kind"], CanonicalTuiClassification>

export function classifyCanonicalEvent(kind: string): CanonicalTuiClassification | "unsupported" {
  if (!isKnownCanonicalAgentEventKind(kind)) return "unsupported"
  return CANONICAL_TUI_CLASSIFICATION[kind]
}

/** Stable correlation key for a tool call (tool name + serialized input). */
export function toolCallKey(toolName: string, input: Record<string, unknown>): string {
  let serialized = ""
  try {
    serialized = JSON.stringify(input)
  } catch {
    serialized = ""
  }
  return `${toolName}:${serialized}`
}

export function captureEventToActions(event: CaptureStreamEvent): TuiAction[] {
  switch (event.type) {
    case "text-delta":
      return event.delta.length > 0 ? [{ type: "INFLIGHT_TEXT", delta: event.delta }] : []
    case "thinking-delta":
      return event.delta.length > 0 ? [{ type: "INFLIGHT_THINKING", delta: event.delta }] : []
    case "tool-call":
      return [
        {
          type: "TOOL_CALL",
          // Prefer the SDK's stable `tool_use` id: it pairs a result exactly and,
          // unlike name+input, keeps two concurrent calls with identical args
          // distinct. Fall back to name+input when the provider gives no id.
          callKey: event.id ?? toolCallKey(event.toolName, event.input),
          toolName: event.toolName,
          input: event.input,
        },
      ]
    case "tool-result": {
      // Same correlation key the TOOL_CALL used, so the reducer pairs them
      // exactly: the `tool_use_id` when present, else name+input when the result
      // carries its originating input. Absent both ⇒ no callKey (nameless result).
      const callKey =
        event.id ?? (event.input ? toolCallKey(event.toolName, event.input) : undefined)
      return [
        {
          type: "TOOL_RESULT",
          toolName: event.toolName,
          ...(event.input ? { input: event.input } : {}),
          ...(callKey ? { callKey } : {}),
          result: event.result,
          ...(event.isError ? { isError: true } : {}),
        },
      ]
    }
    case "usage":
      if (event.partial) {
        const used = Number(event.usage.contextTokens)
        const size = Number(event.usage.contextWindow)
        return Number.isFinite(used) && Number.isFinite(size) && size > 0
          ? [{ type: "SET_CONTEXT_USAGE", used, size }]
          : []
      }
      return [{ type: "SET_USAGE", usage: event.usage }]
    case "compact":
      return [
        {
          type: "COMPACT_BOUNDARY",
          trigger: event.trigger,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
        },
      ]
    default:
      return []
  }
}

function eventTitle(event: CanonicalAgentEvent): string {
  switch (event.kind) {
    case "failure":
      return "Agent failure"
    case "warning":
      return "Warning"
    case "capability-error":
      return "Capability unavailable"
    case "model-refusal":
      return "Model refusal"
    case "prompt-suggestion":
      return "Prompt suggestion"
    case "plugin-install":
      return "Plugin installation"
    case "permission-request":
      return "Permission requested"
    case "elicitation-request":
      return "Input requested"
    default:
      return event.kind.replaceAll("-", " ")
  }
}

function eventSummary(event: CanonicalAgentEvent): string {
  switch (event.kind) {
    case "lifecycle":
      return event.detail ? `${event.phase}: ${event.detail}` : event.phase
    case "user-input":
      return "User input recorded"
    case "permission-request":
      return event.toolName
    case "permission-resolved":
      return `${event.requestId}: ${event.behavior}`
    case "subagent":
      return event.runtimeBinding ? `${event.phase}: ${event.runtimeBinding}` : event.phase
    case "checkpoint":
      return event.checkpointId
    case "elicitation-request":
      return `${event.source}: ${event.prompt}`
    case "elicitation-resolved":
      return `${event.requestId}: ${event.outcome}`
    case "retry":
      return `${event.phase} ${event.attempt}/${event.maxRetries}: ${event.code}`
    case "queue":
      return `${event.phase}: ${event.delivery}${event.reason ? ` (${event.reason})` : ""}`
    case "resource":
      return `${event.phase} ${event.resourceKind}: ${event.origin}`
    case "session-init":
      return event.model ? `model ${event.model}` : "Session initialized"
    case "activity":
      return event.detail ? `${event.phase}: ${event.detail}` : event.phase
    case "session-state":
      return event.state
    case "hook":
      return `${event.hookName}: ${event.phase}${event.outcome ? ` (${event.outcome})` : ""}`
    case "tool-progress":
      return `${event.toolName}: ${Math.max(0, Math.round(event.elapsedMs / 1000))}s`
    case "tool-summary":
      return event.summary
    case "auth":
      return event.error ?? (event.authenticating ? "Authenticating" : "Authentication settled")
    case "task":
      return event.summary ?? event.description ?? `${event.taskId}: ${event.phase}`
    case "task-inventory":
      return `${event.tasks.length} active task${event.tasks.length === 1 ? "" : "s"}`
    case "notification":
      return event.text
    case "informational":
      return event.content
    case "commands-changed":
      return `${event.commands.length} command${event.commands.length === 1 ? "" : "s"} available`
    case "memory-recall":
      return `${event.memories.length} ${event.mode} memory item${event.memories.length === 1 ? "" : "s"}`
    case "files-persisted":
      return `${event.files.length} persisted, ${event.failed?.length ?? 0} failed`
    case "model-refusal":
      return event.explanation ?? event.content
    case "local-command-output":
      return event.content
    case "control-progress":
      return `${event.requestId}: ${event.status}`
    case "prompt-suggestion":
      return event.suggestion
    case "conversation-reset":
      return `New conversation: ${event.newConversationId}`
    case "rate-limit":
      return event.rateLimitType ? `${event.status}: ${event.rateLimitType}` : event.status
    case "worker-shutdown":
      return event.reason
    case "mirror-error":
      return event.error
    case "plugin-install":
      return event.error ?? `${event.name ?? "Plugin"}: ${event.status}`
    case "user-replay":
      return event.preview ?? event.messageId
    case "structured-output":
      return event.status
    case "warning":
      return `${event.code}: ${event.message}`
    case "failure":
      return `${event.code}: ${event.message}`
    case "capability-error":
      return event.command ? `${event.capability}: ${event.command}` : event.capability
    case "diagnostic":
      return `${event.runtime} diagnostic (details hidden; enable raw diagnostics to inspect)`
    case "text-delta":
    case "thinking-delta":
    case "commentary-delta":
    case "content-part":
    case "tool-call":
    case "tool-result":
    case "usage":
    case "compact":
      return event.kind
  }
}

function eventLevel(event: CanonicalAgentEvent): "info" | "warning" | "error" {
  if (event.kind === "failure" || event.kind === "capability-error") return "error"
  if (
    event.kind === "warning" ||
    event.kind === "model-refusal" ||
    event.kind === "mirror-error" ||
    (event.kind === "rate-limit" && event.status !== "allowed")
  ) {
    return "warning"
  }
  return "info"
}

/** Map the preferred canonical stream without falling back to legacy events. */
export function canonicalEnvelopeToActions(envelope: AgentEventEnvelope): TuiAction[] {
  const event = envelope.event
  if (!isKnownCanonicalAgentEventKind(event.kind)) {
    return [
      {
        type: "CANONICAL_EVENT_NOTICE",
        eventId: envelope.eventId,
        level: "warning",
        title: "Unsupported event",
        summary: String(event.kind),
      },
    ]
  }

  switch (event.kind) {
    case "text-delta":
      return event.delta ? [{ type: "INFLIGHT_TEXT", delta: event.delta }] : []
    case "thinking-delta":
      return event.delta ? [{ type: "INFLIGHT_THINKING", delta: event.delta }] : []
    case "commentary-delta":
      return event.delta || event.done
        ? [
            {
              type: "COMMENTARY_DELTA",
              eventId: envelope.eventId,
              messageId: event.messageId ?? envelope.eventId,
              delta: event.delta,
              done: event.done ?? false,
            },
          ]
        : []
    case "content-part":
      if (event.operation === "remove") {
        return [{ type: "CONTENT_PART_REMOVE", partId: event.partId }]
      }
      if (!event.part) {
        return [
          {
            type: "CANONICAL_EVENT_NOTICE",
            eventId: envelope.eventId,
            level: "warning",
            title: "Invalid content part",
            summary: `${event.partId}: upsert payload missing`,
          },
        ]
      }
      const validated = validateContentPart(event.part)
      return validated.ok
        ? [{ type: "CONTENT_PART_UPSERT", partId: event.partId, part: validated.part }]
        : [
            {
              type: "CANONICAL_EVENT_NOTICE",
              eventId: envelope.eventId,
              level: "warning",
              title: "Rejected content part",
              summary: validated.reason,
            },
          ]
    case "tool-call":
      return [
        {
          // A canonical tool-call is still a real ordering boundary. Mapping it
          // to TOOL_UPDATE left the preceding assistant text in `inflight`, so
          // every tool card rendered first and all prose was committed at turn
          // end. The reducer makes repeated snapshots idempotent by callKey and
          // enriches their input in place.
          type: "TOOL_CALL",
          callKey: event.toolCallId ?? toolCallKey(event.toolName, event.input),
          toolName: event.toolName,
          input: event.input,
        },
      ]
    case "tool-result":
      return [
        {
          type: "TOOL_RESULT",
          toolName: event.toolName,
          ...(event.toolCallId ? { callKey: event.toolCallId } : {}),
          ...(event.input ? { input: event.input } : {}),
          result: event.result,
          ...(event.isError ? { isError: true } : {}),
        },
      ]
    case "usage":
      return event.partial
        ? Number.isFinite(Number(event.usage.used)) &&
          Number.isFinite(Number(event.usage.size)) &&
          Number(event.usage.size) > 0
          ? [
              {
                type: "SET_CONTEXT_USAGE",
                used: Number(event.usage.used),
                size: Number(event.usage.size),
              },
            ]
          : []
        : [
            {
              type: "SET_USAGE",
              usage: event.usage as Parameters<typeof Object.assign>[0],
            } as TuiAction,
          ]
    case "compact":
      return [
        {
          type: "COMPACT_BOUNDARY",
          trigger: event.trigger,
          preTokens: event.preTokens ?? 0,
          postTokens: event.postTokens ?? 0,
        },
      ]
    default: {
      const classification = CANONICAL_TUI_CLASSIFICATION[event.kind]
      return [
        {
          type: "CANONICAL_EVENT_NOTICE",
          eventId: envelope.eventId,
          level: eventLevel(event),
          title: eventTitle(event),
          summary: eventSummary(event),
          ...(classification === "status" || classification === "interactive"
            ? { ephemeral: true }
            : {}),
        },
      ]
    }
  }
}
