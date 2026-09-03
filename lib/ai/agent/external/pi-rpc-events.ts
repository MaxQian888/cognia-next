/**
 * Pi RPC event → canonical `ExternalAgentEvent` mapping.
 *
 * Split out of the adapter because it is the part worth testing exhaustively:
 * pure, synchronous, and the only place Pi's vocabulary is interpreted. The
 * adapter owns processes and sessions; this owns meaning.
 *
 * Wire shapes are taken from the `docs/rpc.md` that ships inside
 * `@earendil-works/pi-coding-agent@0.84.1`, not inferred from behaviour, so
 * the field names below are authoritative for that version.
 *
 * Two mappings are load-bearing and easy to get wrong:
 *
 *   - **Only `agent_settled` produces `done`.** Pi also emits `agent_end`
 *     (one LLM run finished) and `turn_end` (one tool loop finished), either of
 *     which can be followed by an automatic retry or a queued continuation.
 *     Treating those as completion truncates the turn mid-flight.
 *   - **`message_update` carries no cumulative snapshot.** Pi deliberately
 *     removed it, so deltas must be forwarded as deltas; anything that expects
 *     a running `message` field silently renders nothing.
 */

import type { ExternalAgentEvent, ExternalAgentTokenUsage } from "@/types/agent/external-agent"

import { decodePiPermissionTitle } from "./pi-permission"

// ============================================================================
// Pi wire types (docs/rpc.md, Pi 0.84.1)
// ============================================================================

/** Delta shapes carried by `message_update.assistantMessageEvent`. */
export interface PiAssistantMessageEvent {
  type:
    | "text_start"
    | "text_delta"
    | "text_end"
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end"
    | "toolcall_start"
    | "toolcall_delta"
    | "toolcall_end"
  contentIndex?: number
  delta?: string
  content?: string
  toolCall?: { id?: string; name?: string; arguments?: unknown }
}

export interface PiToolResultPayload {
  content?: Array<{ type?: string; text?: string }>
  details?: Record<string, unknown>
}

/** The subset of Pi's usage block Cognia projects onto canonical usage. */
export interface PiSessionStats {
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  cost?: number
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number }
}

/** Any inbound non-response frame. Fields are per-event; see `docs/rpc.md`. */
export interface PiEvent {
  type: string
  [key: string]: unknown
}

// ============================================================================
// Mapping
// ============================================================================

export interface PiEventMapContext {
  sessionId: string
  /** Injected so tests get stable timestamps instead of wall-clock drift. */
  now?: () => Date
}

/** Flatten Pi's `{content: [{type:"text", text}]}` result into plain text. */
export function piResultToText(result: PiToolResultPayload | undefined): string {
  if (!result?.content?.length) return ""
  return result.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
}

/** Project Pi's `get_session_stats` payload onto canonical token usage. */
export function piStatsToTokenUsage(
  stats: PiSessionStats | undefined
): ExternalAgentTokenUsage | undefined {
  if (!stats?.tokens) return undefined
  const t = stats.tokens
  const promptTokens = t.input ?? 0
  const completionTokens = t.output ?? 0
  return {
    promptTokens,
    completionTokens,
    // Pi reports `total` inclusive of cache traffic, so prefer it when present
    // rather than recomputing a number that would disagree with Pi's own UI.
    totalTokens: t.total ?? promptTokens + completionTokens,
    cacheReadTokens: t.cacheRead,
    cacheWriteTokens: t.cacheWrite,
    contextTokens: stats.contextUsage?.tokens,
    modelContextWindow: stats.contextUsage?.contextWindow,
  }
}

/**
 * Events that mean "work is happening" but carry no canonical vocabulary of
 * their own. Mapped to `progress` with a stable message so the UI can show
 * motion without the adapter inventing a new event type per Pi feature.
 *
 * `progress: -1` marks indeterminate work — Pi reports no completion ratio for
 * any of these, and reporting `0` would render as a stalled bar.
 */
const PROGRESS_EVENTS: Record<string, string> = {
  agent_start: "pi.agentStart",
  turn_start: "pi.turnStart",
  turn_end: "pi.turnEnd",
  agent_end: "pi.agentEnd",
  compaction_start: "pi.compactionStart",
  compaction_end: "pi.compactionEnd",
  auto_retry_start: "pi.retryStart",
  auto_retry_end: "pi.retryEnd",
  summarization_retry_scheduled: "pi.summarizationRetryScheduled",
  summarization_retry_attempt_start: "pi.summarizationRetryStart",
  summarization_retry_finished: "pi.summarizationRetryFinished",
  queue_update: "pi.queueUpdate",
  bash_execution_update: "pi.bashOutput",
}

/** Fire-and-forget extension UI methods — informational, never blocking. */
const INFORMATIONAL_UI_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
])

/**
 * Map one Pi event onto zero or more canonical events.
 *
 * Returns an array because some Pi events carry no canonical meaning (block
 * start/end markers) and others could expand. Unknown event types map to
 * nothing rather than an error: Pi adds events between releases, and an
 * unrecognised one is not a reason to fail a turn.
 */
export function mapPiEvent(event: PiEvent, ctx: PiEventMapContext): ExternalAgentEvent[] {
  const timestamp = (ctx.now ?? (() => new Date()))()
  const sessionId = ctx.sessionId
  const base = { sessionId, timestamp }

  switch (event.type) {
    case "message_start":
      return [{ ...base, type: "message_start", role: "assistant" }]

    case "message_end": {
      // Pi reports a failed turn HERE, on the assistant message it could not
      // produce: `stopReason: "error"` with the provider's own message. Nothing
      // read it, so a refused turn reached Cognia as a perfectly ordinary
      // message end. The session stayed `streaming` with no text and no error,
      // which meant the status edge that settles the turn never fired, its
      // managed workspace run stayed `running`, and the NEXT turn in that
      // session was refused for good with "pipeline workspace is already
      // active". A provider saying "insufficient balance" or
      // "MODEL_NOT_IN_PLAN" wedged the conversation instead of showing why.
      //
      // Emitted BEFORE `message_end` so a consumer that tears the message down
      // on end still sees the reason. Recoverable: Pi keeps the session, and
      // the same prompt on a model the plan includes succeeds.
      // Read from the event root AND from a nested `message`: Pi's persisted
      // session record carries both fields under `message`, and the RPC frame
      // has been seen either way. Checking one shape only is how a refusal goes
      // unnoticed on the shape that was not checked.
      const message = asRecord(event.message)
      const stopReason = asString(event.stopReason) ?? asString(message?.stopReason)
      if (stopReason !== "error") return [{ ...base, type: "message_end" }]
      const detail = asString(event.errorMessage) ?? asString(message?.errorMessage)
      return [
        {
          ...base,
          type: "error",
          error: detail ?? "The agent's provider refused this turn",
          recoverable: true,
        },
        { ...base, type: "message_end" },
      ]
    }

    case "message_update":
      return mapAssistantMessageEvent(
        event.assistantMessageEvent as PiAssistantMessageEvent | undefined,
        base
      )

    case "tool_execution_start": {
      const toolUseId = asString(event.toolCallId)
      if (!toolUseId) return []
      return [
        {
          ...base,
          type: "tool_use_start",
          toolUseId,
          toolName: asString(event.toolName) ?? "unknown",
          rawInput: asRecord(event.args),
        },
      ]
    }

    case "tool_execution_update": {
      const toolCallId = asString(event.toolCallId)
      if (!toolCallId) return []
      // `partialResult` is cumulative, not a delta — Pi's docs are explicit
      // that clients should replace rather than append. `tool_call_update`
      // carries replace semantics; `tool_use_delta` would double the output.
      return [
        {
          ...base,
          type: "tool_call_update",
          toolCallId,
          status: "in_progress",
          rawInput: asRecord(event.args),
          rawOutput: asRecord(event.partialResult),
        },
      ]
    }

    case "tool_execution_end": {
      const toolUseId = asString(event.toolCallId)
      if (!toolUseId) return []
      const isError = event.isError === true
      const result = event.result as PiToolResultPayload | undefined
      return [
        {
          ...base,
          type: "tool_result",
          toolUseId,
          toolName: asString(event.toolName),
          result: piResultToText(result),
          isError,
          rawOutput: asRecord(event.result),
          status: isError ? "failed" : "completed",
        },
      ]
    }

    // The ONLY completion signal. `agent_end` and `turn_end` both precede
    // possible retries and queued continuations.
    case "agent_settled":
      return [{ ...base, type: "done", success: true }]

    case "extension_error":
      return [
        {
          ...base,
          type: "error",
          error: asString(event.error) ?? asString(event.message) ?? "Pi extension error",
          // An extension throwing does not end the run; Pi keeps going.
          recoverable: true,
        },
      ]

    case "extension_ui_request":
      return mapExtensionUiRequest(event, base)

    default: {
      const message = PROGRESS_EVENTS[event.type]
      if (!message) return []
      return [{ ...base, type: "progress", progress: -1, message }]
    }
  }
}

function mapAssistantMessageEvent(
  delta: PiAssistantMessageEvent | undefined,
  base: { sessionId: string; timestamp: Date }
): ExternalAgentEvent[] {
  if (!delta || typeof delta.type !== "string") return []

  switch (delta.type) {
    case "text_delta":
      return delta.delta
        ? [{ ...base, type: "message_delta", delta: { type: "text", text: delta.delta } }]
        : []

    case "thinking_delta":
      return delta.delta ? [{ ...base, type: "thinking", thinking: delta.delta }] : []

    case "toolcall_delta": {
      // Arguments stream as text before the call is complete. There is no id
      // until `toolcall_end`, so this is only useful as a live preview.
      const id = asString(delta.toolCall?.id)
      return id && delta.delta
        ? [{ ...base, type: "tool_use_delta", toolUseId: id, delta: delta.delta }]
        : []
    }

    case "toolcall_end": {
      const id = asString(delta.toolCall?.id)
      if (!id) return []
      return [
        {
          ...base,
          type: "tool_use_end",
          toolUseId: id,
          input: asRecord(delta.toolCall?.arguments) ?? {},
        },
      ]
    }

    // `*_start` / `*_end` are block markers. `text_end` repeats the whole
    // block as `content`; emitting it would duplicate every streamed token.
    default:
      return []
  }
}

function mapExtensionUiRequest(
  event: PiEvent,
  base: { sessionId: string; timestamp: Date }
): ExternalAgentEvent[] {
  const method = asString(event.method)
  if (!method) return []

  if (INFORMATIONAL_UI_METHODS.has(method)) {
    // Each fire-and-forget method carries its payload under its OWN field
    // name (verified against Pi 0.84.1's docs and its real output): `notify`
    // uses `message`, `setStatus` uses `statusText`, `setWidget` uses
    // `widgetLines`, `setTitle` uses `title`, `set_editor_text` uses `text`.
    // Reading only a generic `text` would render most of them blank.
    const widget = Array.isArray(event.widgetLines)
      ? (event.widgetLines as unknown[]).filter((l): l is string => typeof l === "string").join(" ")
      : undefined
    const text =
      asString(event.message) ??
      asString(event.statusText) ??
      widget ??
      asString(event.title) ??
      asString(event.text) ??
      `pi.${method}`
    return [{ ...base, type: "progress", progress: -1, message: text }]
  }

  // Dialog methods block the extension until answered. Most are the extension
  // asking the user something and surface as elicitation — Cognia's decisions
  // about its OWN projected tools are made by the tool-host broker, never here.
  //
  // The exception is a native-tool approval raised by the bundled extension,
  // which carries a versioned marker. That is a permission decision about
  // Pi's own `bash`/`write`/`edit`, and it belongs in the tool approval dialog
  // with its allow/deny/allow-always affordances, not in a generic form.
  const id = asString(event.id)
  if (!id) return []

  const title = asString(event.title)
  const message = asString(event.message)

  const approval = method === "confirm" ? decodePiPermissionTitle(title) : undefined
  if (approval) {
    return [
      {
        ...base,
        type: "permission_request",
        request: {
          id,
          requestId: id,
          sessionId: base.sessionId,
          title: `Allow ${approval.tool}?`,
          toolInfo: { id: approval.tool, name: approval.tool },
          // The human-readable description the extension built; the marker
          // itself never reaches the user.
          reason: message,
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Deny", kind: "reject_once" },
          ],
          metadata: { piPermissionMode: approval.mode },
        },
      },
    ]
  }
  return [
    {
      ...base,
      type: "elicitation_request",
      request: {
        id,
        // Every Pi dialog method collects a value inline; none of them hand
        // the user off to a URL.
        mode: "form",
        // `message` is required by the canonical contract, and `confirm` is
        // the only method that reliably carries one — fall back to the title
        // so the prompt is never blank.
        message: message ?? title ?? `pi.${method}`,
        requestedSchema: piDialogSchema(method, title, event),
        // Carries `method`, `timeout` and anything Pi adds later, so a
        // responder can honour the original request without this mapper
        // having to model every future dialog field.
        raw: { ...event },
      },
    },
  ]
}

/**
 * Describe a Pi dialog as an elicitation schema so the existing renderer can
 * draw it without special-casing Pi. One property named for the method keeps
 * the response shape predictable for the responder in the adapter.
 */
function piDialogSchema(
  method: string,
  title: string | undefined,
  event: PiEvent
): import("@/types/agent/external-agent").AcpElicitationSchema {
  const options = Array.isArray(event.options)
    ? (event.options as unknown[]).filter((o): o is string => typeof o === "string")
    : undefined

  // Pi names these per method (`rpc-types.d.ts`): `select` carries `options`,
  // `input` a `placeholder`, `editor` a `prefill`. Reading only `text` — which
  // belongs to the fire-and-forget `set_editor_text` — meant an editor dialog
  // lost its prefill and an input lost its hint, so the user was asked to retype
  // content the extension had already supplied.
  const property: import("@/types/agent/external-agent").AcpElicitationPropertySchema =
    method === "confirm"
      ? { type: "boolean", title }
      : {
          type: "string",
          title,
          ...(options?.length ? { enum: options } : {}),
          ...(asString(event.placeholder) ? { description: asString(event.placeholder) } : {}),
          ...(asString(event.prefill) ? { default: asString(event.prefill) } : {}),
        }

  return {
    type: "object",
    title: title ?? null,
    properties: { [method]: property },
    required: [method],
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
