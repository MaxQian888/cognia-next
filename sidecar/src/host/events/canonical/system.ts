import { record, asString, asNumber, compact, type CanonicalEvent } from "./common.ts"

export const TASK_PHASE: Record<string, string> = {
  task_started: "started",
  task_updated: "updated",
  task_progress: "progress",
  task_notification: "settled",
}

export function taskUsage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const u = record(value)
  return compact({
    totalTokens: asNumber(u.total_tokens),
    toolUses: asNumber(u.tool_uses),
    durationMs: asNumber(u.duration_ms),
  })
}
function map_init(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "session-init",
      model: asString(evt.model),
      cwd: asString(evt.cwd),
      tools: Array.isArray(evt.tools) ? evt.tools : undefined,
      mcpServers: Array.isArray(evt.mcp_servers)
        ? evt.mcp_servers.map((s: unknown) => ({
            name: String(record(s).name ?? ""),
            status: String(record(s).status ?? ""),
          }))
        : undefined,
      permissionMode: asString(evt.permissionMode),
      slashCommands: Array.isArray(evt.slash_commands) ? evt.slash_commands : undefined,
    }),
  ]
}
function map_compact_boundary(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "compact",
      trigger: record(evt.compact_metadata).trigger === "manual" ? "manual" : "auto",
      preTokens: asNumber(record(evt.compact_metadata).pre_tokens),
      postTokens: asNumber(record(evt.compact_metadata).post_tokens),
    }),
  ]
}
function map_status(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "activity",
      // `status: null` is the SDK's way of saying "nothing in flight".
      phase: evt.status === "compacting" || evt.status === "requesting" ? evt.status : "idle",
      compactResult: evt.compact_result,
      detail: asString(evt.compact_error),
    }),
  ]
}
function map_api_retry(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "retry",
      phase: "scheduled",
      attempt: asNumber(evt.attempt) ?? 0,
      maxRetries: asNumber(evt.max_retries) ?? 0,
      code: evt.error_status == null ? "api_retry" : `http_${evt.error_status}`,
      delayMs: asNumber(evt.retry_delay_ms),
      message: asString(record(evt.error).message),
    }),
  ]
}
function map_control_request_progress(evt: Record<string, unknown>): CanonicalEvent[] {
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
}
function map_model_refusal_fallback(evt: Record<string, unknown>): CanonicalEvent[] {
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
}
function map_local_command_output(evt: Record<string, unknown>): CanonicalEvent[] {
  return [{ kind: "local-command-output", content: String(evt.content ?? "") }]
}
function map_hook_started(evt: Record<string, unknown>): CanonicalEvent[] {
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
}
function map_plugin_install(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "plugin-install",
      status: evt.status ?? "started",
      name: asString(evt.name),
      error: asString(evt.error),
    }),
  ]
}
function map_task_started(evt: Record<string, unknown>): CanonicalEvent[] {
  {
    const patch = record(evt.patch)
    return [
      compact({
        kind: "task",
        phase: TASK_PHASE[String(evt.subtype)],
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
}
function map_background_tasks_changed(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    {
      kind: "task-inventory",
      tasks: (Array.isArray(evt.tasks) ? evt.tasks : []).map((t: unknown) => ({
        taskId: String(record(t).task_id ?? ""),
        taskType: String(record(t).task_type ?? ""),
        description: String(record(t).description ?? ""),
      })),
    },
  ]
}
function map_thinking_tokens(evt: Record<string, unknown>): CanonicalEvent[] {
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
}
function map_session_state_changed(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    {
      kind: "session-state",
      state: evt.state === "requires_action" ? "requires-action" : (evt.state ?? "idle"),
    },
  ]
}
function map_worker_shutting_down(evt: Record<string, unknown>): CanonicalEvent[] {
  return [{ kind: "worker-shutdown", reason: String(evt.reason ?? "") }]
}
function map_commands_changed(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    {
      kind: "commands-changed",
      commands: (Array.isArray(evt.commands) ? evt.commands : []).map((c: unknown) =>
        compact({
          name: String(record(c).name ?? ""),
          description: asString(record(c).description),
          source: asString(record(c).source),
        })
      ),
    },
  ]
}
function map_notification(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "notification",
      key: String(evt.key ?? ""),
      text: String(evt.text ?? ""),
      priority: evt.priority ?? "low",
      timeoutMs: asNumber(evt.timeout_ms),
    }),
  ]
}
function map_files_persisted(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "files-persisted",
      files: (Array.isArray(evt.files) ? evt.files : []).map((f: unknown) => ({
        filename: String(record(f).filename ?? ""),
        fileId: String(record(f).file_id ?? ""),
      })),
      failed:
        Array.isArray(evt.failed) && evt.failed.length
          ? evt.failed.map((f: unknown) => ({
              filename: String(record(f).filename ?? ""),
              error: String(record(f).error ?? ""),
            }))
          : undefined,
      processedAt: asString(evt.processed_at),
    }),
  ]
}
function map_memory_recall(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    {
      kind: "memory-recall",
      mode: evt.mode === "synthesize" ? "synthesize" : "select",
      // `content` is deliberately dropped: the recall body is prompt
      // material, and the canonical log records provenance, not payloads.
      memories: (Array.isArray(evt.memories) ? evt.memories : []).map((m: unknown) => ({
        path: String(record(m).path ?? ""),
        scope: record(m).scope ?? "personal",
      })),
    },
  ]
}
function map_elicitation_complete(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    {
      kind: "elicitation-resolved",
      requestId: String(evt.elicitation_id ?? ""),
      outcome: "answered",
    },
  ]
}
function map_permission_denied(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: "permission-resolved", requestId: String(evt.tool_use_id ?? ""), behavior: "deny" },
  ]
}
function map_mirror_error(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "mirror-error",
      error: String(evt.error ?? ""),
      projectKey: asString(record(evt.key).projectKey),
      storeSessionId: asString(record(evt.key).sessionId),
      subpath: asString(record(evt.key).subpath),
    }),
  ]
}
function map_informational(evt: Record<string, unknown>): CanonicalEvent[] {
  return [
    compact({
      kind: "informational",
      content: String(evt.content ?? ""),
      level: evt.level ?? "info",
      toolCallId: asString(evt.tool_use_id),
      preventContinuation: evt.prevent_continuation === true ? true : undefined,
    }),
  ]
}
function map_hook_audit(evt: Record<string, unknown>): CanonicalEvent[] {
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
}
function map_hook_fire(evt: Record<string, unknown>): CanonicalEvent[] {
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
}
const SYSTEM_HANDLERS: Record<
  string,
  ((event: Record<string, unknown>) => CanonicalEvent[]) | undefined
> = {
  init: map_init,
  compact_boundary: map_compact_boundary,
  status: map_status,
  api_retry: map_api_retry,
  control_request_progress: map_control_request_progress,
  model_refusal_fallback: map_model_refusal_fallback,
  model_refusal_no_fallback: map_model_refusal_fallback,
  local_command_output: map_local_command_output,
  hook_started: map_hook_started,
  hook_progress: map_hook_started,
  hook_response: map_hook_started,
  plugin_install: map_plugin_install,
  task_started: map_task_started,
  task_updated: map_task_started,
  task_progress: map_task_started,
  task_notification: map_task_started,
  background_tasks_changed: map_background_tasks_changed,
  thinking_tokens: map_thinking_tokens,
  session_state_changed: map_session_state_changed,
  worker_shutting_down: map_worker_shutting_down,
  commands_changed: map_commands_changed,
  notification: map_notification,
  files_persisted: map_files_persisted,
  memory_recall: map_memory_recall,
  elicitation_complete: map_elicitation_complete,
  permission_denied: map_permission_denied,
  mirror_error: map_mirror_error,
  informational: map_informational,
  hook_audit: map_hook_audit,
  hook_fire: map_hook_fire,
}
export function fromSystem(evt: Record<string, unknown>): CanonicalEvent[] {
  const handler =
    typeof evt.subtype === "string" && Object.hasOwn(SYSTEM_HANDLERS, evt.subtype)
      ? SYSTEM_HANDLERS[evt.subtype]
      : undefined
  return handler
    ? handler(evt)
    : [{ kind: "diagnostic", runtime: "claude-agent-sdk", payload: evt }]
}
