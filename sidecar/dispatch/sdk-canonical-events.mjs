// Exhaustive `SDKMessage` -> canonical agent event mapping (ADR-0090, plan §2.4).
//
// The Claude Agent SDK's `SDKMessage` union has 39 members. Before this module
// the renderer's `applySdkEvent` handled 9 of them and the envelope emitter
// projected exactly one (`compact_boundary`), so the other 30 reached a default
// branch and vanished: tool progress, background tasks, plugin installs, memory
// recalls, mirror failures, model refusals. Nothing errored — the information
// simply did not exist downstream.
//
// The 39 members collapse to 11 distinct `type` values, 28 of which are
// `type: 'system'` separated only by `subtype`. That shape is recorded in
// `protocol/agent-sdk-surface.json` (`wire` + `canonical` per member) and the
// `check:sdk-surface` gate proves this file still agrees with the installed
// `sdk.d.ts`, so a new SDK member fails CI instead of being swallowed.
//
// Mapping rules that are NOT obvious:
//
//   * One SDK message may produce SEVERAL canonical events (an assistant turn
//     with two tool calls) or none (a heartbeat with no new information), so
//     the entry point returns an array.
//   * Text is emitted from exactly ONE source per attempt. When the SDK is
//     streaming partials, `stream_event` owns the deltas and the authoritative
//     `assistant` message contributes only its tool calls; without partials the
//     `assistant` message carries the text. Emitting from both would duplicate
//     every assistant turn in the persisted log.
//   * `mirror_error` is deliberately not a `failure`. The turn is unaffected —
//     it is the SDK-side session mirror that lost an entry, which is a
//     durability alarm, not a turn outcome.

import { classifyStructuredOutcome } from "@cognia/agent-config-types/claude-agent-sdk-options"

/**
 * Fresh per-attempt state for {@link canonicalEventsFromSdkMessage}.
 *
 * `expectStructuredOutput` has to be supplied by the caller because the result
 * message cannot be asked: a turn that requested a schema and got nothing looks
 * exactly like a turn that never requested one. Only whoever set `outputFormat`
 * knows, and that is the send options.
 *
 * @param {{ expectStructuredOutput?: boolean }} [opts]
 */
export function createSdkMappingState(opts = {}) {
  return { sawStreamEvents: false, expectStructuredOutput: opts.expectStructuredOutput === true }
}

const asString = (v) => (typeof v === "string" ? v : undefined)
const asNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/** Drop undefined values so envelopes stay stable across emitters. */
function compact(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

function contentBlocks(message) {
  const content = message?.content
  if (Array.isArray(content)) return content
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  return []
}

/** Assistant turn: tool calls always, text only when nothing streamed it. */
function fromAssistant(evt, state) {
  const events = []
  for (const block of contentBlocks(evt.message)) {
    if (block?.type === "tool_use") {
      events.push(
        compact({
          kind: "tool-call",
          toolName: String(block.name ?? ""),
          input: block.input && typeof block.input === "object" ? block.input : {},
          toolCallId: asString(block.id),
        })
      )
    } else if (!state.sawStreamEvents && block?.type === "text" && block.text) {
      events.push({ kind: "text-delta", delta: String(block.text) })
    } else if (!state.sawStreamEvents && block?.type === "thinking" && block.thinking) {
      events.push({ kind: "thinking-delta", delta: String(block.thinking) })
    }
  }
  return events
}

/**
 * User turn. `isReplay` is the runtime echoing a message back with the id it
 * assigned — the id `rewindFiles` needs — so it becomes `user-replay` rather
 * than a second copy of the user's input.
 */
function fromUser(evt) {
  if (evt.isReplay) {
    const text = contentBlocks(evt.message)
      .filter((b) => b?.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("")
    return [
      compact({
        kind: "user-replay",
        messageId: String(evt.uuid ?? ""),
        preview: text ? text.slice(0, 200) : undefined,
        synthetic: evt.isSynthetic === true ? true : undefined,
      }),
    ]
  }

  const events = []
  let text = ""
  for (const block of contentBlocks(evt.message)) {
    if (block?.type === "tool_result") {
      events.push(
        compact({
          kind: "tool-result",
          toolName: asString(block.tool_name) ?? "",
          toolCallId: asString(block.tool_use_id),
          result: block.content,
          isError: block.is_error === true ? true : undefined,
        })
      )
    } else if (block?.type === "text") {
      text += String(block.text ?? "")
    }
  }
  if (text) events.unshift({ kind: "user-input", text })
  return events
}

/** Token-level partials. Also latches the flag that mutes assistant text. */
function fromStreamEvent(evt, state) {
  state.sawStreamEvents = true
  const delta = evt.event?.delta
  if (delta?.type === "text_delta" && delta.text) {
    return [{ kind: "text-delta", delta: String(delta.text) }]
  }
  if (delta?.type === "thinking_delta" && delta.thinking) {
    return [{ kind: "thinking-delta", delta: String(delta.thinking) }]
  }
  const start = evt.event?.content_block
  if (evt.event?.type === "content_block_start" && start?.type === "tool_use") {
    return [
      compact({
        kind: "tool-call",
        toolName: String(start.name ?? ""),
        input: {},
        toolCallId: asString(start.id),
      }),
    ]
  }
  return []
}

/**
 * Turn settlement: usage, then the structured-output verdict, then the outcome.
 *
 * The verdict is emitted BEFORE the outcome so a consumer that stops reading at
 * `lifecycle: ended` has already seen it, and because it can change the outcome:
 * a turn the SDK calls a success is a FAILURE for us when a schema was
 * requested and no `structured_output` came back. Reporting that as `ended`
 * hands the caller `undefined` from a turn it was told had worked.
 */
function fromResult(evt, state) {
  const events = []
  if (evt.usage && typeof evt.usage === "object") {
    events.push({ kind: "usage", usage: evt.usage })
  }

  const structured = classifyStructuredOutcome(evt, state?.expectStructuredOutput === true)
  if (structured) {
    events.push(compact({ kind: "structured-output", ...structured }))
  }

  const sdkSucceeded = evt.subtype === "success" && evt.is_error !== true
  if (sdkSucceeded && structured?.status === "missing") {
    events.push({
      kind: "failure",
      code: "structured_output_missing",
      message: "the turn completed but returned no structured_output for the requested json_schema",
      // The model answered in prose once; asking again can land differently, so
      // unlike a budget ceiling this is worth another attempt.
      retryable: true,
    })
    return events
  }
  if (sdkSucceeded) {
    events.push({ kind: "lifecycle", phase: "ended" })
  } else {
    events.push(
      compact({
        kind: "failure",
        code: String(evt.subtype ?? "error"),
        message: asString(evt.result) ?? String(evt.subtype ?? "error"),
        // Budget and turn ceilings are the caller's policy, not a transient
        // fault — retrying the same request hits the same wall. Schema retries
        // are likewise already exhausted by the SDK itself.
        retryable: evt.subtype === "error_during_execution" ? true : undefined,
      })
    )
  }
  return events
}

const TASK_PHASE = {
  task_started: "started",
  task_updated: "updated",
  task_progress: "progress",
  task_notification: "settled",
}

function taskUsage(u) {
  if (!u || typeof u !== "object") return undefined
  return compact({
    totalTokens: asNumber(u.total_tokens),
    toolUses: asNumber(u.tool_uses),
    durationMs: asNumber(u.duration_ms),
  })
}

/** The 28 `type: 'system'` members, keyed by `subtype`. */
function fromSystem(evt) {
  switch (evt.subtype) {
    case "init":
      return [
        compact({
          kind: "session-init",
          model: asString(evt.model),
          cwd: asString(evt.cwd),
          tools: Array.isArray(evt.tools) ? evt.tools : undefined,
          mcpServers: Array.isArray(evt.mcp_servers)
            ? evt.mcp_servers.map((s) => ({
                name: String(s?.name ?? ""),
                status: String(s?.status ?? ""),
              }))
            : undefined,
          permissionMode: asString(evt.permissionMode),
          slashCommands: Array.isArray(evt.slash_commands) ? evt.slash_commands : undefined,
        }),
      ]

    case "compact_boundary":
      return [
        compact({
          kind: "compact",
          trigger: evt.compact_metadata?.trigger === "manual" ? "manual" : "auto",
          preTokens: asNumber(evt.compact_metadata?.pre_tokens),
          postTokens: asNumber(evt.compact_metadata?.post_tokens),
        }),
      ]

    case "status":
      return [
        compact({
          kind: "activity",
          // `status: null` is the SDK's way of saying "nothing in flight".
          phase: evt.status === "compacting" || evt.status === "requesting" ? evt.status : "idle",
          compactResult: evt.compact_result,
          detail: asString(evt.compact_error),
        }),
      ]

    case "api_retry":
      return [
        compact({
          kind: "retry",
          phase: "scheduled",
          attempt: asNumber(evt.attempt) ?? 0,
          maxRetries: asNumber(evt.max_retries) ?? 0,
          code: evt.error_status == null ? "api_retry" : `http_${evt.error_status}`,
          delayMs: asNumber(evt.retry_delay_ms),
          message: asString(evt.error?.message),
        }),
      ]

    case "control_request_progress":
      return [
        compact({
          kind: "control-progress",
          requestId: String(evt.request_id ?? ""),
          status: evt.status === "api_retry" ? "api-retry" : "started",
          attempt: asNumber(evt.attempt),
          maxRetries: asNumber(evt.max_retries),
          delayMs: asNumber(evt.retry_delay_ms),
        }),
      ]

    case "model_refusal_fallback":
    case "model_refusal_no_fallback":
      return [
        compact({
          kind: "model-refusal",
          originalModel: String(evt.original_model ?? ""),
          fallbackModel: asString(evt.fallback_model),
          direction: asString(evt.direction),
          category: asString(evt.api_refusal_category),
          explanation: asString(evt.api_refusal_explanation),
          content: String(evt.content ?? ""),
          retractedEventIds: Array.isArray(evt.retracted_message_uuids)
            ? evt.retracted_message_uuids.map(String)
            : undefined,
          refusedUserMessageId: asString(evt.refused_user_message_uuid),
        }),
      ]

    case "local_command_output":
      return [{ kind: "local-command-output", content: String(evt.content ?? "") }]

    case "hook_started":
    case "hook_progress":
    case "hook_response":
      return [
        compact({
          kind: "hook",
          phase:
            evt.subtype === "hook_started"
              ? "started"
              : evt.subtype === "hook_progress"
                ? "progress"
                : "completed",
          hookId: String(evt.hook_id ?? ""),
          hookName: String(evt.hook_name ?? ""),
          hookEvent: String(evt.hook_event ?? ""),
          outcome: asString(evt.outcome),
          exitCode: asNumber(evt.exit_code),
          output: asString(evt.output),
        }),
      ]

    case "plugin_install":
      return [
        compact({
          kind: "plugin-install",
          status: evt.status ?? "started",
          name: asString(evt.name),
          error: asString(evt.error),
        }),
      ]

    case "task_started":
    case "task_updated":
    case "task_progress":
    case "task_notification": {
      const patch = evt.patch && typeof evt.patch === "object" ? evt.patch : {}
      return [
        compact({
          kind: "task",
          phase: TASK_PHASE[evt.subtype],
          taskId: String(evt.task_id ?? ""),
          toolCallId: asString(evt.tool_use_id),
          description: asString(evt.description) ?? asString(patch.description),
          subagentType: asString(evt.subagent_type),
          status: asString(evt.status) ?? asString(patch.status),
          summary: asString(evt.summary),
          usage: taskUsage(evt.usage),
          error: asString(patch.error),
          backgrounded:
            typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : undefined,
        }),
      ]
    }

    case "background_tasks_changed":
      return [
        {
          kind: "task-inventory",
          tasks: (Array.isArray(evt.tasks) ? evt.tasks : []).map((t) => ({
            taskId: String(t?.task_id ?? ""),
            taskType: String(t?.task_type ?? ""),
            description: String(t?.description ?? ""),
          })),
        },
      ]

    case "thinking_tokens":
      return [
        {
          kind: "usage",
          usage: compact({
            estimatedThinkingTokens: asNumber(evt.estimated_tokens),
            estimatedThinkingTokensDelta: asNumber(evt.estimated_tokens_delta),
          }),
          partial: true,
        },
      ]

    case "session_state_changed":
      return [
        {
          kind: "session-state",
          state: evt.state === "requires_action" ? "requires-action" : (evt.state ?? "idle"),
        },
      ]

    case "worker_shutting_down":
      return [{ kind: "worker-shutdown", reason: String(evt.reason ?? "") }]

    case "commands_changed":
      return [
        {
          kind: "commands-changed",
          commands: (Array.isArray(evt.commands) ? evt.commands : []).map((c) =>
            compact({
              name: String(c?.name ?? ""),
              description: asString(c?.description),
              source: asString(c?.source),
            })
          ),
        },
      ]

    case "notification":
      return [
        compact({
          kind: "notification",
          key: String(evt.key ?? ""),
          text: String(evt.text ?? ""),
          priority: evt.priority ?? "low",
          timeoutMs: asNumber(evt.timeout_ms),
        }),
      ]

    case "files_persisted":
      return [
        compact({
          kind: "files-persisted",
          files: (Array.isArray(evt.files) ? evt.files : []).map((f) => ({
            filename: String(f?.filename ?? ""),
            fileId: String(f?.file_id ?? ""),
          })),
          failed:
            Array.isArray(evt.failed) && evt.failed.length
              ? evt.failed.map((f) => ({
                  filename: String(f?.filename ?? ""),
                  error: String(f?.error ?? ""),
                }))
              : undefined,
          processedAt: asString(evt.processed_at),
        }),
      ]

    case "memory_recall":
      return [
        {
          kind: "memory-recall",
          mode: evt.mode === "synthesize" ? "synthesize" : "select",
          // `content` is deliberately dropped: the recall body is prompt
          // material, and the canonical log records provenance, not payloads.
          memories: (Array.isArray(evt.memories) ? evt.memories : []).map((m) => ({
            path: String(m?.path ?? ""),
            scope: m?.scope ?? "personal",
          })),
        },
      ]

    case "elicitation_complete":
      return [
        {
          kind: "elicitation-resolved",
          requestId: String(evt.elicitation_id ?? ""),
          outcome: "answered",
        },
      ]

    case "permission_denied":
      return [
        { kind: "permission-resolved", requestId: String(evt.tool_use_id ?? ""), behavior: "deny" },
      ]

    case "mirror_error":
      return [
        compact({
          kind: "mirror-error",
          error: String(evt.error ?? ""),
          projectKey: asString(evt.key?.projectKey),
          storeSessionId: asString(evt.key?.sessionId),
          subpath: asString(evt.key?.subpath),
        }),
      ]

    case "informational":
      return [
        compact({
          kind: "informational",
          content: String(evt.content ?? ""),
          level: evt.level ?? "info",
          toolCallId: asString(evt.tool_use_id),
          preventContinuation: evt.prevent_continuation === true ? true : undefined,
        }),
      ]

    case "hook_audit":
      return [
        compact({
          kind: "hook",
          phase: "completed",
          hookId: String(evt.hookId ?? ""),
          hookName: String(evt.handlerType ?? "unknown"),
          hookEvent: String(evt.hookEvent ?? ""),
          outcome: evt.outcome === "blocked" || evt.outcome === "warning" ? "error" : "success",
          blocked: evt.outcome === "blocked" ? true : undefined,
          blockReason: asString(evt.blockReason),
          provider: asString(evt.provider),
          handlerType: asString(evt.handlerType),
          policyClass: evt.policyClass === "managed" ? "managed" : "user",
          latencyMs: asNumber(evt.latencyMs),
          redacted: evt.redacted === true ? true : undefined,
          error: asString(evt.error),
        }),
      ]

    // `hook_fire` is synthesized by the Rust hook runtime, not the SDK
    // (src-tauri/src/claude/sidecar.rs:emit_hook_fire), so it is not in the
    // union the gate checks — but it rides the same channel and must map.
    case "hook_fire":
      return [
        compact({
          kind: "hook",
          phase: "completed",
          hookId: asString(evt.uuid) ?? "",
          hookName: asString(evt.hook_event) ?? "",
          hookEvent: String(evt.hook_event ?? ""),
          outcome: evt.outcome === "blocked" ? "error" : "success",
          blocked: evt.outcome === "blocked" ? true : undefined,
          blockReason: asString(evt.block),
          additionalContext: asString(evt.additional_context),
          warnings: Array.isArray(evt.warnings) && evt.warnings.length ? evt.warnings : undefined,
        }),
      ]

    default:
      return [{ kind: "diagnostic", runtime: "claude-agent-sdk", payload: evt }]
  }
}

/**
 * Map one raw `SDKMessage` to zero or more canonical agent events.
 *
 * @param {any} evt
 * @param {{ sawStreamEvents: boolean }} state per-attempt, from {@link createSdkMappingState}
 * @returns {any[]}
 */
export function canonicalEventsFromSdkMessage(evt, state = createSdkMappingState()) {
  if (!evt || typeof evt !== "object") return []

  switch (evt.type) {
    case "assistant":
      return fromAssistant(evt, state)
    case "user":
      return fromUser(evt)
    case "stream_event":
      return fromStreamEvent(evt, state)
    case "result":
      return fromResult(evt, state)
    case "system":
      return fromSystem(evt)

    case "tool_progress":
      return [
        compact({
          kind: "tool-progress",
          toolCallId: String(evt.tool_use_id ?? ""),
          toolName: String(evt.tool_name ?? ""),
          elapsedMs: Math.round((asNumber(evt.elapsed_time_seconds) ?? 0) * 1000),
          parentToolCallId: asString(evt.parent_tool_use_id),
          taskId: asString(evt.task_id),
          heartbeat: evt.heartbeat === true ? true : undefined,
          subagentType: asString(evt.subagent_type),
        }),
      ]

    case "tool_use_summary":
      return [
        {
          kind: "tool-summary",
          summary: String(evt.summary ?? ""),
          toolCallIds: Array.isArray(evt.preceding_tool_use_ids)
            ? evt.preceding_tool_use_ids.map(String)
            : [],
        },
      ]

    case "auth_status":
      return [
        compact({
          kind: "auth",
          authenticating: evt.isAuthenticating === true,
          output:
            Array.isArray(evt.output) && evt.output.length ? evt.output.map(String) : undefined,
          error: asString(evt.error),
        }),
      ]

    case "rate_limit_event": {
      const info = evt.rate_limit_info
      if (!info || typeof info !== "object") return []
      return [
        compact({
          kind: "rate-limit",
          status: info.status ?? "allowed",
          rateLimitType: asString(info.rateLimitType),
          resetsAt: asNumber(info.resetsAt),
        }),
      ]
    }

    case "prompt_suggestion":
      return [{ kind: "prompt-suggestion", suggestion: String(evt.suggestion ?? "") }]

    case "conversation_reset":
      return [
        { kind: "conversation-reset", newConversationId: String(evt.new_conversation_id ?? "") },
      ]

    default:
      // A member this build has never seen. Preserved as a diagnostic rather
      // than dropped — `check:sdk-surface` is what turns it into a CI failure.
      return [{ kind: "diagnostic", runtime: "claude-agent-sdk", payload: evt }]
  }
}
