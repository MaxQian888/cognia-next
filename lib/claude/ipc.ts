// Thin wrapper around the Claude sidecar IPC. Components should use this
// module rather than touching @tauri-apps/api directly — every boundary
// goes through `transport` from `@/lib/tauri`.

import type { UnlistenFn } from "@tauri-apps/api/event"
import type { UIMessage } from "@/types"
import { transport } from "@/lib/tauri"
import { reportGovernanceProjectionFailure } from "@/lib/db/governance-ledger"
import type {
  AgentId,
  ApprovalDecision,
  ChatSession,
  ClaudeEvent,
  PluginToolExecEvent,
  SdkContextUsage,
  SdkMcpServerStatus,
  SdkModelInfo,
  SdkSlashCommand,
  SendContent,
  SendOptions,
  SessionApiMethod,
  SessionControlMethod,
  StoredMessage,
} from "@cognia/agent-config-types"
import {
  isControlResponseEvent,
  isPluginToolExecEvent,
  isProtocolAdapterCancelEvent,
  isSessionApiResponseEvent,
} from "@cognia/agent-config-types"
import type { PluginToolExecResponse } from "./plugin-tool-ipc"
import type { ProtocolAdapterExecEvent } from "./protocol-adapter-ipc"
import type { ProtocolAdapterCancelEvent } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { isRemoteExecutionContext, type RemoteExecutionContext } from "./remote-execution"

const SIDECAR_EVENT = "claude://message"
/** Canonical agent-event channel (ADR-0090 Phase 3). */
const AGENT_EVENT = "agent://message"
const remoteApprovalContexts = new Map<string, RemoteExecutionContext>()

function remoteApprovalKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`
}

export async function sendPrompt(
  sessionId: string,
  prompt: SendContent,
  options?: SendOptions,
  delivery?: { commandId?: string }
): Promise<void> {
  const sdk = options?.claudeAgentSdk
  if (
    !hasNoLeakingPiiDeep({
      prompt,
      systemPrompt: options?.systemPrompt,
      appendSystemPrompt: options?.appendSystemPrompt,
      ...(options?.agents ? { agents: options.agents } : {}),
      ...(sdk
        ? {
            claudeAgentSdk: {
              outputFormat: sdk.outputFormat,
              permissionPromptToolName: sdk.permissionPromptToolName,
              planModeInstructions: sdk.planModeInstructions,
              plugins: sdk.plugins,
              skills: sdk.skills,
              toolAliases: sdk.toolAliases,
              toolConfig: sdk.toolConfig,
              tools: sdk.tools,
            },
          }
        : {}),
    })
  ) {
    throw new Error("prompt rejected by the renderer PII gate")
  }
  // Sends carrying a frozen execution spec use the canonical command (same
  // impl body Rust-side; the alias split feeds the Phase 9 telemetry).
  const command = options?.execution || delivery?.commandId ? "agent_send" : "claude_send"
  await transport.call(command, {
    sessionId,
    prompt,
    options,
    ...(delivery?.commandId ? { commandId: delivery.commandId } : {}),
  })
}

/**
 * Subscribe to canonical `AgentEventEnvelope` frames (ADR-0090 Phase 3).
 * Emitted only for sessions that carry a frozen execution spec — legacy
 * sessions produce nothing here.
 */
export async function subscribeAgentEvents(
  onEnvelope: (
    envelope: import("@cognia/agent-config-types/agent-execution").AgentEventEnvelope
  ) => void
): Promise<UnlistenFn> {
  const { isAgentEventEnvelope } = await import("@cognia/agent-config-types/agent-execution")
  return transport.subscribe<{ type: string; envelope?: unknown }>(AGENT_EVENT, (payload) => {
    const envelope = payload?.envelope
    if (isAgentEventEnvelope(envelope)) onEnvelope(envelope)
  })
}

export async function interruptSession(
  sessionId: string,
  options?: { commandId?: string }
): Promise<void> {
  const command = options?.commandId ? "agent_interrupt" : "claude_interrupt"
  await transport.call(command, {
    sessionId,
    ...(options?.commandId ? { commandId: options.commandId } : {}),
  })
}

/**
 * Manually compact a running session's context. Mirrors {@link interruptSession}
 * — a fire-and-forget control message routed to the sidecar. On the generic
 * (AI-SDK) path the sidecar runs a summary round-trip now; on the Anthropic
 * path it pushes a `/compact` turn the Agent SDK intercepts. `focus` is the
 * optional compact-instruction argument (e.g. from `/compact <focus>`).
 */
export async function compactSession(
  sessionId: string,
  focus?: string,
  options?: { commandId?: string }
): Promise<void> {
  const command = options?.commandId ? "agent_compact" : "claude_compact"
  await transport.call(command, {
    sessionId,
    focus,
    ...(options?.commandId ? { commandId: options.commandId } : {}),
  })
}

/**
 * Undo a prior compaction by restoring the pre-compaction message snapshot.
 * Mirrors {@link compactSession}: a fire-and-forget control message. `messages`
 * is the sidecar-format snapshot captured on the `compact_boundary` event
 * (`compact_metadata.pre_messages`) — NOT renderer UIMessages. Only valid on the
 * generic (AI-SDK) path while the session is still live and idle.
 */
export async function restoreSession(sessionId: string, messages: unknown[]): Promise<void> {
  if (!hasNoLeakingPiiDeep(messages)) {
    throw new Error("session restore rejected by the renderer PII gate")
  }
  await transport.call("claude_restore", { sessionId, messages })
}

/**
 * Change a running session's permission mode in place — without tearing down
 * and respawning the sidecar (which would lose the in-process conversation).
 * Mirrors {@link compactSession}: a fire-and-forget control message. On the
 * Anthropic path the sidecar calls the live SDK `Query.setPermissionMode`; on
 * both paths it mutates the session's `sendOptions.permissionMode` so the next
 * tool gate honours the change.
 */
export async function setSessionMode(
  sessionId: string,
  mode: NonNullable<SendOptions["permissionMode"]>,
  options?: { commandId?: string }
): Promise<void> {
  await transport.call("claude_set_mode", { sessionId, mode, commandId: options?.commandId })
}

// ---- Live session introspection & control (SDK Query control methods) ----
//
// The renderer drives the Claude Agent SDK `Query`'s streaming-input-only
// control methods on a LIVE session through a request/response round-trip:
// `claude_session_control` writes a `control` line to the sidecar stdin; the
// sidecar invokes `q[method](...)` and replies with a `control_response` event
// (correlated by `requestId`) on the same `claude://message` channel. The
// correlation reuses the single `onClaudeMessage` subscription — exactly like
// {@link subscribePluginToolExec} — so it is decoupled from the chat hook's
// lifecycle (the Settings MCP tab can call it with no chat mounted).

interface PendingControl {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingControl = new Map<string, PendingControl>()
/** Lazily-created singleton listener that settles `control_response` events. */
let controlListener: Promise<UnlistenFn> | null = null

function ensureControlListener(): Promise<UnlistenFn> {
  if (!controlListener) {
    controlListener = onClaudeMessage((evt) => {
      // Fail-fast on a sidecar crash/restart: the PROCESS died, so every
      // in-flight control request (model picker, MCP settings action,
      // context-usage poll) can never be answered. Reject them now instead of
      // each waiting out CONTROL_TIMEOUT_MS — mirrors run-and-capture's
      // `sidecar_exited` posture so a control issued just before a restart
      // doesn't hang the UI for 8s.
      if (evt.type === "sidecar_exited") {
        for (const [id, pending] of pendingControl) {
          pendingControl.delete(id)
          clearTimeout(pending.timer)
          pending.reject(new Error("sidecar exited"))
        }
        return
      }
      // Both round-trips settle here. They share the map because they share a
      // requestId space and the crash handling above: a session_api call
      // orphaned by a sidecar restart is exactly as unanswerable as a control.
      if (!isControlResponseEvent(evt) && !isSessionApiResponseEvent(evt)) return
      const pending = pendingControl.get(evt.requestId)
      if (!pending) return
      pendingControl.delete(evt.requestId)
      clearTimeout(pending.timer)
      if (evt.ok) pending.resolve(evt.result)
      else pending.reject(new Error(evt.error ?? "control_failed"))
    })
  }
  return controlListener
}

/** Reject if the sidecar hasn't replied within this window. */
const CONTROL_TIMEOUT_MS = 8000

/**
 * Invoke an allowlisted SDK `Query` control method on a live session and await
 * its result. Rejects with `control "<method>" timed out` after
 * {@link CONTROL_TIMEOUT_MS}, or with the sidecar's stable error code
 * (`no_active_session` | `unsupported_provider` | `unknown_method`) when the
 * call can't run. Anthropic-path + open-session only — callers degrade
 * gracefully on rejection.
 */
async function sidecarRoundTrip<T>(
  command: string,
  buildArgs: (requestId: string) => Record<string, unknown>,
  label: string,
  timeoutMs: number
): Promise<T> {
  // Await the subscription before firing so a fast reply can't race the listener.
  await ensureControlListener()
  const requestId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControl.delete(requestId)
      reject(new Error(`${label} timed out`))
    }, timeoutMs)
    pendingControl.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    })
    transport.call(command, buildArgs(requestId)).catch((err) => {
      const pending = pendingControl.get(requestId)
      if (!pending) return
      pendingControl.delete(requestId)
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

async function sessionControlRequest<T>(
  sessionId: string,
  method: SessionControlMethod,
  params?: Record<string, unknown>,
  options?: { commandId?: string }
): Promise<T> {
  return sidecarRoundTrip<T>(
    "claude_session_control",
    (requestId) => ({ sessionId, requestId, method, params, commandId: options?.commandId }),
    `control "${method}"`,
    CONTROL_TIMEOUT_MS
  )
}

export async function sessionControl<T = unknown>(
  sessionId: string,
  method: Exclude<SessionControlMethod, "steer">,
  params?: Record<string, unknown>,
  options?: { commandId?: string }
): Promise<T> {
  if ((method as SessionControlMethod) === "steer") {
    throw new Error("steer must use the PII-gated steerSession wrapper")
  }
  return sessionControlRequest<T>(sessionId, method, params, options)
}

/** Live context-window usage from the SDK (authoritative window + breakdown). */
export function getSessionContextUsage(sessionId: string): Promise<SdkContextUsage> {
  return sessionControl<SdkContextUsage>(sessionId, "getContextUsage")
}

/** Live MCP client status for the running session (one entry per server). */
export function getSessionMcpStatus(sessionId: string): Promise<SdkMcpServerStatus[]> {
  return sessionControl<SdkMcpServerStatus[]>(sessionId, "mcpServerStatus")
}

/**
 * Reconnect a failed/needs-auth MCP server on the running session.
 *
 * The wire param is `serverName`, matching the SDK's own parameter name. Every
 * control's params are named after the SDK signature so that
 * `protocol/agent-control-methods.json` can carry one `args` list and the gate
 * can compare it against `controlArgs` — the old `name` here was the single
 * exception, and it was already out of step with the manifest.
 */
export function reconnectSessionMcpServer(sessionId: string, serverName: string): Promise<void> {
  return sessionControl<void>(sessionId, "reconnectMcpServer", { serverName })
}

/** Enable/disable an MCP server on the running session. */
export function toggleSessionMcpServer(
  sessionId: string,
  serverName: string,
  enabled: boolean
): Promise<unknown> {
  return sessionControl<unknown>(sessionId, "toggleMcpServer", { serverName, enabled })
}

/** Account-authoritative model list (with per-model capability flags). */
export function getSessionSupportedModels(sessionId: string): Promise<SdkModelInfo[]> {
  return sessionControl<SdkModelInfo[]>(sessionId, "supportedModels")
}

/** Agent-facing slash-command list as the SDK currently sees it. */
export function getSessionSupportedCommands(sessionId: string): Promise<SdkSlashCommand[]> {
  return sessionControl<SdkSlashCommand[]>(sessionId, "supportedCommands")
}

/** Switch the model on the running query in place (no session restart). */
export function setSessionModel(
  sessionId: string,
  model: string,
  options?: { commandId?: string }
): Promise<void> {
  return sessionControl<void>(sessionId, "setModel", { model }, options)
}

/**
 * Queue a user message into the active Anthropic streaming-input query.
 * Success acknowledges sidecar queue acceptance only; the SDK applies the
 * message at its next supported boundary and may not mutate an HTTP request
 * that is already in flight.
 */
export async function steerSession(
  sessionId: string,
  prompt: SendContent,
  sourceMessageId?: string,
  options?: { priority?: "now" | "next"; commandId?: string }
): Promise<{ accepted: true }> {
  if (!hasNoLeakingPiiDeep(prompt)) {
    throw new Error("live-steer prompt rejected by the renderer PII gate")
  }
  return sessionControlRequest<{ accepted: true }>(
    sessionId,
    "steer",
    {
      prompt,
      priority: options?.priority ?? "now",
      ...(sourceMessageId ? { sourceMessageId } : {}),
    },
    options
  )
}

export interface RewindFilesResult {
  status: "ready" | "unavailable" | "unknown"
  reason?: string
  paths: string[]
}

/** Normalize SDK-version-specific rewind previews at the IPC boundary. */
export function normalizeRewindFilesResult(value: unknown): RewindFilesResult {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const candidates = [record.paths, record.files, record.affectedFiles, record.changedFiles]
  const paths =
    candidates.find(Array.isArray)?.flatMap((item) => {
      if (typeof item === "string" && item) return [item]
      if (!item || typeof item !== "object") return []
      const row = item as Record<string, unknown>
      const path = row.path ?? row.filePath ?? row.file_path
      return typeof path === "string" && path ? [path] : []
    }) ?? []
  const reason = typeof record.reason === "string" ? record.reason : undefined
  const status =
    record.canRewind === false
      ? "unavailable"
      : record.canRewind === true || paths.length > 0
        ? "ready"
        : "unknown"
  return { status, ...(reason ? { reason } : {}), paths: [...new Set(paths)] }
}

// ---- Session-level SDK functions (the `session_api` frame) ----------------
//
// `sessionControl` above drives a LIVE query by session id. These do the
// opposite: they read and mutate transcripts on disk with no session running,
// which is what makes session management reachable from Settings with no chat
// open. Same correlation machinery, different Tauri command and frame type.

/**
 * A filesystem scan across every project directory can genuinely outrun the
 * 8s control budget on a large machine, and a timeout there reads to the user
 * as a broken feature rather than a slow one.
 */
const SESSION_API_TIMEOUT_MS = 20_000

/**
 * Call an allowlisted session-level SDK function and await its result.
 *
 * `sendOptions` names the SessionStore backend for the call — it is forwarded
 * verbatim to the sidecar, which resolves it to a live store. The renderer
 * never sends a store: the descriptor names a backend, never a location.
 *
 * Rejects with the sidecar's stable error code (`unknown_method`,
 * `invalid_session_id`, `no_session_store`, …) or `sidecar exited`. Callers
 * that can run against a non-Anthropic runtime must gate on
 * `SESSION_API_CAPABILITIES` first — this is IPC, and ADR-0090 constraint 3
 * wants the fail-closed decision made before it.
 */
export async function sessionApi<T = unknown>(
  method: SessionApiMethod,
  params?: Record<string, unknown>,
  sendOptions?: Pick<SendOptions, "cwd" | "execution" | "claudeAgentSdk">
): Promise<T> {
  return sidecarRoundTrip<T>(
    "agent_session_api",
    (requestId) => ({ requestId, method, params, sendOptions }),
    `session api "${method}"`,
    SESSION_API_TIMEOUT_MS
  )
}

/** Sessions the SDK can see, from the store and/or `dir`'s transcripts. */
export function listSdkSessions<T = unknown>(
  params?: { dir?: string },
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<T> {
  return sessionApi<T>("listSessions", params, sendOptions)
}

/** Metadata for one session (title, tag, timestamps). */
export function getSdkSessionInfo<T = unknown>(
  sessionId: string,
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<T> {
  return sessionApi<T>("getSessionInfo", { sessionId }, sendOptions)
}

/**
 * One session's message chain.
 *
 * This is the COMPACTED chain — the SDK drops what compaction replaced. A
 * caller that needs the raw history reads the store directly rather than
 * "fixing" a short result by re-fetching here.
 */
export function getSdkSessionMessages<T = unknown>(
  sessionId: string,
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<T> {
  return sessionApi<T>("getSessionMessages", { sessionId }, sendOptions)
}

/** Subagents that ran inside a session. */
export function listSdkSubagents<T = unknown>(
  sessionId: string,
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<T> {
  return sessionApi<T>("listSubagents", { sessionId }, sendOptions)
}

/** One subagent's own message chain. */
export function getSdkSubagentMessages<T = unknown>(
  sessionId: string,
  agentId: string,
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<T> {
  return sessionApi<T>("getSubagentMessages", { sessionId, agentId }, sendOptions)
}

/** Retitle a session. */
export function renameSdkSession(
  sessionId: string,
  title: string,
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<void> {
  return sessionApi<void>("renameSession", { sessionId, title }, sendOptions)
}

/** Set or clear a session's tag. `null` is the documented "clear" value. */
export function tagSdkSession(
  sessionId: string,
  tag: string | null,
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<void> {
  return sessionApi<void>("tagSession", { sessionId, tag }, sendOptions)
}

/**
 * Delete a session's transcript.
 *
 * Irreversible, and it cascades to the session's subagent transcripts. Callers
 * owe the user a confirmation — {@link isMutatingSessionApiMethod} is exported
 * from the contract so a UI can decide that from the method rather than from a
 * hand-maintained list of "the scary ones".
 */
export function deleteSdkSession(
  sessionId: string,
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<void> {
  return sessionApi<void>("deleteSession", { sessionId }, sendOptions)
}

/** Copy a session so a new branch can diverge from it. */
export function forkSdkSession<T = unknown>(
  sessionId: string,
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<T> {
  return sessionApi<T>("forkSession", { sessionId }, sendOptions)
}

/**
 * Copy a local JSONL transcript into the configured SessionStore.
 *
 * Requires a store — without one the sidecar rejects with `no_session_store`
 * rather than silently doing nothing.
 */
export function importSdkSessionToStore<T = unknown>(
  sessionId: string,
  sendOptions?: Pick<SendOptions, "cwd" | "execution" | "claudeAgentSdk">
): Promise<T> {
  return sessionApi<T>("importSessionToStore", { sessionId }, sendOptions)
}

/** The effective settings layers the SDK would apply (user/project/local). */
export function resolveSdkSettings<T = unknown>(
  params?: { dir?: string },
  sendOptions?: Pick<SendOptions, "cwd" | "execution">
): Promise<T> {
  return sessionApi<T>("resolveSettings", params, sendOptions)
}

// ---- Mobile-only message + session RPCs (mobile completeness Phase 2) ----

/**
 * Page of sessions returned by `session_list`. Sorted desktop-side by
 * `updatedAt` descending. Rows are lightweight list projections rather than
 * full execution configuration. `next_offset`/`has_more` are set when more
 * rows remain; direct/degraded stores may additionally return `total`.
 */
export interface SessionListPage {
  rows: Array<
    Pick<
      ChatSession,
      | "id"
      | "title"
      | "kind"
      | "projectId"
      | "characterId"
      | "teamId"
      | "lastMessagePreview"
      | "lastMessageAt"
      | "createdAt"
      | "updatedAt"
    >
  >
  total?: number
  next_offset?: number
  has_more?: boolean
}

/**
 * Patch a message on the desktop's Dexie. The mobile client uses this
 * during edit-and-resend so the desktop's authoritative store stays in
 * lockstep. Round-trips through `_rpc/message_update` → Tauri event →
 * `messageRepository.update`.
 */
export async function updateMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<UIMessage>
): Promise<void> {
  await transport.call("message_update", { sessionId, messageId, updates })
}

/**
 * Delete a message on the desktop's Dexie. Used by the mobile
 * regenerate / edit flows when the local truncate must mirror to the
 * desktop's store.
 */
export async function deleteMessage(sessionId: string, messageId: string): Promise<void> {
  await transport.call("message_delete", { sessionId, messageId })
}

/**
 * Paginated read of the desktop's `sessions` table. Read-only —
 * structurally idempotent so the companion transport skips the
 * idempotency-key header.
 */
export async function listSessions(opts: {
  limit: number
  offset: number
  before?: number
}): Promise<SessionListPage> {
  return transport.call<SessionListPage>("session_list", opts)
}

/**
 * Paginated read of one session's messages. Used by the mobile companion to
 * hydrate a chat history without taking ownership of the desktop's Dexie
 * snapshot. Round-trips through `_rpc/message_get_by_session` → desktop
 * Tauri command → an indexed raw `StoredMessage` page.
 *
 * Returns rows sorted by `createdAt` ascending so the mobile client can
 * append them to its scrollback in order.
 */
export interface MobileMessagesPage {
  rows: StoredMessage[]
  /** Present on legacy/direct-store responses; omitted by the indexed bridge. */
  total?: number
  next_offset?: number
}

export async function getMessagesBySession(
  sessionId: string,
  limit?: number,
  offset?: number
): Promise<MobileMessagesPage> {
  return transport.call<MobileMessagesPage>("message_get_by_session", {
    session_id: sessionId,
    limit,
    offset,
  })
}

/**
 * Initiate a mobile-originated send. The desktop side is authoritative —
 * this RPC enqueues the prompt against the existing session and returns the
 * id of the user message that was appended. The downstream assistant
 * response streams back via the standard `claude://message` Tauri event,
 * which the desktop bridges to the mobile websocket / push channel.
 */
export interface MobileMessageSendResult {
  messageId?: string
  ok: boolean
}

export async function sendMessageFromMobile(
  sessionId: string,
  content: string,
  role?: "user" | "assistant" | "system"
): Promise<MobileMessageSendResult> {
  return transport.call<MobileMessageSendResult>("message_send", {
    session_id: sessionId,
    content,
    role,
  })
}

export async function approveTool(
  sessionId: string,
  requestId: string,
  decision: ApprovalDecision,
  message?: string,
  updatedInput?: unknown,
  remoteExecutionContext?: RemoteExecutionContext
): Promise<void> {
  const { recordToolAuthorizationGovernance } =
    await import("@/lib/governance/producers/tool-authorization")
  const key = remoteApprovalKey(sessionId, requestId)
  const context = remoteExecutionContext ?? remoteApprovalContexts.get(key)
  const decidedAt = Date.now()
  const governanceOutcome = decision === "deny" ? "deny" : "allow"
  try {
    await transport.call("claude_approve", {
      sessionId,
      requestId,
      decision,
      message,
      updatedInput,
      ...(context ? { remoteExecutionContext: context } : {}),
    })
    try {
      await recordToolAuthorizationGovernance({
        sessionId,
        requestId,
        outcome: governanceOutcome,
        decidedAt,
        dispatched: true,
        hasUpdatedInput: updatedInput !== undefined,
      })
    } catch (error) {
      await reportGovernanceProjectionFailure(
        {
          producer: "tool-authorization",
          operation: "record-dispatched",
          subjectRef: {
            namespace: "cognia",
            type: "tool-authorization",
            id: `${sessionId}:${requestId}`,
          },
          occurredAt: decidedAt,
        },
        error
      )
    }
  } catch (error) {
    try {
      await recordToolAuthorizationGovernance({
        sessionId,
        requestId,
        outcome: governanceOutcome,
        decidedAt,
        dispatched: false,
        hasUpdatedInput: updatedInput !== undefined,
      })
    } catch (projectionError) {
      await reportGovernanceProjectionFailure(
        {
          producer: "tool-authorization",
          operation: "record-failed-dispatch",
          subjectRef: {
            namespace: "cognia",
            type: "tool-authorization",
            id: `${sessionId}:${requestId}`,
          },
          occurredAt: decidedAt,
        },
        projectionError
      )
    }
    throw error
  } finally {
    remoteApprovalContexts.delete(key)
  }
}

/**
 * Answer a `tool_result_review` (the plugin Agent SDK's PostToolUse rewrite).
 * `updatedToolOutput` is the rewritten output the model should see; pass
 * `undefined` to leave the tool result unchanged. Mirrors
 * `approveTool`/`claude_approve` but for tool OUTPUT.
 */
export async function toolResultDecision(
  sessionId: string,
  reviewId: string,
  updatedToolOutput?: unknown,
  remoteExecutionContext?: RemoteExecutionContext
): Promise<void> {
  await transport.call("claude_tool_result_decision", {
    sessionId,
    reviewId,
    updatedToolOutput,
    remoteExecutionContext,
  })
}

export async function closeSession(
  sessionId: string,
  options?: { commandId?: string }
): Promise<void> {
  const command = options?.commandId ? "agent_close_session" : "claude_close_session"
  await transport.call(command, {
    sessionId,
    ...(options?.commandId ? { commandId: options.commandId } : {}),
  })
}

export async function getSidecarStatus(): Promise<{ ready: boolean }> {
  return transport.call<{ ready: boolean }>("claude_sidecar_status")
}

export async function setApiKey(key: string | null): Promise<void> {
  await transport.call("claude_set_api_key", { key })
}

/**
 * Replace the Anthropic provider env (api key + optional base URL) atomically.
 * Used by the CCSwitch provider-switch flow so the sidecar restart sees a
 * coherent (key, base-url) pair rather than a half-switched state.
 *
 * Pass `null` for either field to clear it. Empty strings are treated as null
 * by the Rust side.
 *
 * `customHeaders` carries relay-required headers (e.g.
 * `{ "anthropic-beta": "context-1m-2025-08-07" }` for the 1M window), forwarded
 * as `ANTHROPIC_CUSTOM_HEADER_*` at sidecar spawn. Semantics on the Rust side:
 * `undefined` leaves the existing header set untouched (legacy callers that
 * don't manage headers); an explicit object — including `{}` — replaces it, so
 * switching to a provider without headers clears a previous relay's headers.
 */
export async function setProviderEnv(
  apiKey: string | null,
  baseUrl: string | null,
  customHeaders?: Record<string, string>
): Promise<void> {
  await transport.call("claude_set_provider_env", {
    apiKey,
    baseUrl,
    customHeaders: customHeaders ? Object.entries(customHeaders) : undefined,
  })
}

export async function hasApiKey(): Promise<boolean> {
  return transport.call<boolean>("claude_has_api_key")
}

// `setOauthBearer` was removed in ADR-0025 — the unified subscription module
// pushes the bearer into `ApiKeyState` server-side via `subscription_set_active`.
// Renderers that previously called `setOauthBearer(token)` + `restartSidecar()`
// now call `subscription_set_active("anthropic", accountId)` (see
// `lib/subscription/anthropic/sidecar-sync.ts`). The Rust-side
// `claude_set_oauth_bearer` command continues to exist for the diagnostics
// `hasOauthBearer()` read below and as a transitional surface during the
// migration window, but no renderer code calls it directly.

export async function hasOauthBearer(): Promise<boolean> {
  return transport.call<boolean>("claude_has_oauth_bearer")
}

export async function restartSidecar(): Promise<void> {
  await transport.call("claude_restart_sidecar")
}

export async function onClaudeMessage(handler: (evt: ClaudeEvent) => void): Promise<UnlistenFn> {
  return transport.subscribe<ClaudeEvent>(SIDECAR_EVENT, (event) => {
    const routed = event as ClaudeEvent & { remoteExecutionContext?: unknown }
    if (
      (routed as { type?: string }).type === "permission_request" &&
      "sessionId" in routed &&
      "requestId" in routed &&
      typeof routed.sessionId === "string" &&
      typeof routed.requestId === "string" &&
      isRemoteExecutionContext(routed.remoteExecutionContext)
    ) {
      remoteApprovalContexts.set(
        remoteApprovalKey(routed.sessionId, routed.requestId),
        routed.remoteExecutionContext
      )
    }
    handler(event)
  })
}

/**
 * Subscribe to `plugin_tool_exec` events on the sidecar channel and forward
 * them to `handler` (which runs the tool via `handlePluginToolExec` and writes
 * the result back with `sendPluginToolResponse`). Reuses the single
 * `onClaudeMessage` subscription + the `ClaudeEvent` type guard. No-op in web.
 */
export async function subscribePluginToolExec(
  handler: (req: PluginToolExecEvent & { remoteExecutionContext?: RemoteExecutionContext }) => void
): Promise<UnlistenFn> {
  return onClaudeMessage((evt) => {
    if (isPluginToolExecEvent(evt)) handler(evt)
  })
}

/**
 * Write a `plugin_tool_response` back onto the sidecar stdin so the pending
 * `pendingPluginToolCalls` entry resolves. Mirrors `approveTool`/`claude_approve`.
 */
export async function sendPluginToolResponse(
  resp: PluginToolExecResponse,
  remoteExecutionContext?: RemoteExecutionContext
): Promise<void> {
  await transport.call("claude_plugin_tool_response", {
    sessionId: resp.sessionId,
    toolUseId: resp.toolUseId,
    result: resp.result,
    error: resp.error,
    ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
  })
}

/**
 * Subscribe to `protocol_adapter_exec` events (P2-E code adapter round-trip)
 * and forward them to `handler`. Reuses the single `onClaudeMessage`
 * subscription. No-op in web.
 */
export async function subscribeProtocolAdapterExec(
  handler: (req: ProtocolAdapterExecEvent) => void
): Promise<UnlistenFn> {
  return onClaudeMessage((evt) => {
    if ((evt as { type?: string }).type === "protocol_adapter_exec") {
      handler(evt as unknown as ProtocolAdapterExecEvent)
    }
  })
}

export async function subscribeProtocolAdapterCancel(
  handler: (req: ProtocolAdapterCancelEvent) => void
): Promise<UnlistenFn> {
  return onClaudeMessage((evt) => {
    if (isProtocolAdapterCancelEvent(evt)) handler(evt)
  })
}

/** Write a `protocol_adapter_{chunk,done,error}` line onto the sidecar stdin. */
export async function sendProtocolAdapterMessage(
  message: Record<string, unknown>,
  remoteExecutionContext?: RemoteExecutionContext
): Promise<void> {
  const routedMessage = {
    ...message,
    messageId: crypto.randomUUID(),
  }
  await transport.call("claude_protocol_adapter_message", {
    message: routedMessage,
    ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
    ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
  })
}

// ---- File-system commands (Skills + MCP import/export) -------------------

export async function readTextFile(path: string): Promise<string> {
  return transport.call<string>("read_text_file", { path })
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await transport.call("write_text_file", { path, content })
}

/**
 * Write a text file confined to `allowedRoots` (the active workspace roots).
 * The authoritative on-disk counterpart to {@link writeTextFile}: the Rust host
 * canonicalizes and rejects writes that escape the roots — including via a
 * symlink the lexical TS pre-flight can't see. Prefer this for in-app writes.
 */
export async function writeTextFileConfined(
  path: string,
  content: string,
  allowedRoots: string[]
): Promise<void> {
  await transport.call("write_text_file_confined", { path, content, allowedRoots })
}

export async function ensureDir(path: string): Promise<void> {
  await transport.call("ensure_dir", { path })
}

/** Ensure a directory exists, confined to `allowedRoots` (see {@link writeTextFileConfined}). */
export async function ensureDirConfined(path: string, allowedRoots: string[]): Promise<void> {
  await transport.call("ensure_dir_confined", { path, allowedRoots })
}

export async function defaultExportDir(): Promise<string> {
  return transport.call<string>("default_export_dir")
}

export interface DiscoveredSkillFile {
  dirName: string
  filePath: string
  content: string
}

export async function scanClaudeSkills(): Promise<DiscoveredSkillFile[]> {
  const raw =
    await transport.call<Array<{ dir_name: string; file_path: string; content: string }>>(
      "scan_claude_skills"
    )
  return raw.map((r) => ({
    dirName: r.dir_name,
    filePath: r.file_path,
    content: r.content,
  }))
}

export async function readClaudeUserConfig(): Promise<unknown> {
  return transport.call<unknown>("read_claude_user_config")
}

// ---- Multi-agent MCP IO (read / write external agents' config files) -----

export interface AgentReadResult {
  /** Resolved path on this OS, or null when the agent isn't supported here. */
  path: string | null
  exists: boolean
  writable: boolean
  format: "json" | "jsonc" | "toml"
  /** Raw file content (or empty string when missing). */
  raw: string
  /** Parsed canonical JSON tree, or `null` when missing / unparseable. */
  parsed: unknown
  /** Set when the file existed but couldn't be parsed. */
  parseError?: string
}

export async function readAgentConfig(agent: AgentId): Promise<AgentReadResult> {
  return transport.call<AgentReadResult>("read_agent_config", { agent })
}

export interface AgentWriteResult {
  path: string
  backupPath?: string
}

export async function writeAgentConfig(agent: AgentId, value: unknown): Promise<AgentWriteResult> {
  return transport.call<AgentWriteResult>("write_agent_config", { agent, value })
}

/**
 * Read a workspace's project-scoped `.mcp.json`. Read-only: that file is
 * normally committed and shared with the user's teammates, so Cognia imports
 * from it but never writes back.
 */
export async function readProjectMcpConfig(cwd: string): Promise<AgentReadResult> {
  return transport.call<AgentReadResult>("read_project_mcp_config", { cwd })
}

// ---- Skills (native sync, marketplace registry, scanner) -----------------

export interface NativeSkillResource {
  kind: "script" | "reference" | "asset"
  path: string
  name: string
  content: string
  encoding: "utf-8" | "base64"
  mimeType?: string
  size: number
}

export interface NativeSkill {
  dirName: string
  filePath: string
  content: string
  resources: NativeSkillResource[]
  /**
   * SKILL.md mtime in milliseconds since epoch. Zero when filesystem
   * metadata couldn't be read (handled as "unknown" by sync — pull
   * conservatively).
   */
  mtimeMs: number
}

export interface RegistrySkillEntry {
  id: string
  source: string
  sourceType: string
  skillPath?: string
  computedHash?: string
  displayName?: string
  description?: string
  category?: string
  tags?: string[]
  author?: string
  iconUrl?: string
  rawSkillUrl?: string
}

export interface InstallSkillRequest {
  dirName: string
  content: string
  resources: NativeSkillResource[]
  clean: boolean
}

export interface InstallSkillResponse {
  directory: string
  writtenFiles: string[]
}

export type SkillsTarget = "cognia" | "claude" | "codex"

/**
 * Bundle-import-aware install request. Wraps the legacy single-target
 * payload with a `targets` list (cognia + claude + codex toggleable) and
 * a `trashBeforeClean` flag that moves the prior cognia copy into
 * `<appData>/cognia/skills/.trash/` before overwriting.
 */
export interface InstallSkillMirroredRequest extends InstallSkillRequest {
  targets: SkillsTarget[]
  trashBeforeClean: boolean
}

export interface MirrorTargetOutcome {
  target: SkillsTarget
  directory: string
  writtenFiles: string[]
  /** Set when a target was requested but degraded (e.g. no home dir). */
  note?: string | null
}

export interface InstallSkillMirroredResponse {
  targets: MirrorTargetOutcome[]
  /** Path of the trashed prior cognia copy, when applicable. */
  trashedFrom?: string | null
}

export interface HostSkillsCatalog {
  cognia: NativeSkill[]
  claude: NativeSkill[]
  codex: NativeSkill[]
}

export interface SkillBundleUploadHandle {
  handleId: string
  chunkBytes: number
}

export interface SkillScanIssue {
  severity: "low" | "medium" | "high"
  kind: string
  message: string
  line?: number
}

export async function skillsScanNative(): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_native")
}

export async function skillsCatalogGet(): Promise<HostSkillsCatalog> {
  return transport.call<HostSkillsCatalog>("skills_catalog_get")
}

export async function skillsBundleUploadOpen(
  expectedSize: number,
  expectedHash: string
): Promise<SkillBundleUploadHandle> {
  return transport.call<SkillBundleUploadHandle>("skills_bundle_upload_open", {
    request: { expectedSize, expectedHash },
  })
}

export async function skillsBundleUploadWrite(args: {
  handleId: string
  offset: number
  dataBase64: string
  chunkHash: string
}): Promise<number> {
  return transport.call<number>("skills_bundle_upload_write", args)
}

export async function skillsBundleUploadCommit(handleId: string): Promise<void> {
  return transport.call<void>("skills_bundle_upload_commit", { handleId })
}

export async function skillsBundleUploadAbort(handleId: string): Promise<void> {
  return transport.call<void>("skills_bundle_upload_abort", { handleId })
}

export async function skillsInstallAtomic(
  handleId: string,
  adminLease: string
): Promise<InstallSkillMirroredResponse> {
  return transport.call<InstallSkillMirroredResponse>("skills_install_atomic", {
    handleId,
    adminLease,
  })
}

export async function skillsUninstall(
  target: SkillsTarget,
  dirName: string,
  adminLease: string
): Promise<{ removed: boolean; directory: string }> {
  return transport.call<{ removed: boolean; directory: string }>("skills_uninstall", {
    target,
    dirName,
    adminLease,
  })
}

export async function skillsScanDir(path: string): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_dir", { path })
}

export async function skillsScanCodex(): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_codex")
}

/** Scan OpenCode's environment-aware global `skills/` directory. */
export async function skillsScanOpencode(): Promise<NativeSkill[]> {
  const [{ resolveVendorRoots }, { joinPath }] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/claude/instructions/paths"),
  ])
  const { opencodeConfigDir } = await resolveVendorRoots()
  if (!opencodeConfigDir) return []
  return skillsScanDir(joinPath(opencodeConfigDir, "skills"))
}

export async function skillsMoveToTrash(dirName: string): Promise<string> {
  return transport.call<string>("skills_move_to_trash", { dirName })
}

export async function skillsListTrash(): Promise<string[]> {
  return transport.call<string[]>("skills_list_trash")
}

export async function skillsEmptyTrash(): Promise<number> {
  return transport.call<number>("skills_empty_trash")
}

export async function skillsInstallNative(
  request: InstallSkillRequest
): Promise<InstallSkillResponse> {
  return transport.call<InstallSkillResponse>("skills_install_native", { request })
}

export async function skillsInstallMirrored(
  request: InstallSkillMirroredRequest
): Promise<InstallSkillMirroredResponse> {
  return transport.call<InstallSkillMirroredResponse>("skills_install_mirrored", { request })
}

export async function skillsUninstallNative(
  dirName: string
): Promise<{ removed: boolean; directory: string }> {
  return transport.call<{ removed: boolean; directory: string }>("skills_uninstall_native", {
    dirName,
  })
}

export async function skillsFetchRemoteMd(url: string): Promise<string> {
  return transport.call<string>("skills_fetch_remote_md", { url })
}

/** Response of the Rust JSON GET proxy. Non-2xx statuses are returned (not thrown). */
export interface SkillsRemoteGetResponse {
  status: number
  body: string
  retryAfter?: string | null
}

export async function skillsFetchRemoteJson(req: {
  url: string
  bearerToken?: string
  accept?: string
}): Promise<SkillsRemoteGetResponse> {
  return transport.call<SkillsRemoteGetResponse>("skills_fetch_remote_json", { req })
}

export async function skillsLoadRegistry(): Promise<RegistrySkillEntry[]> {
  return transport.call<RegistrySkillEntry[]>("skills_load_registry")
}

export async function skillsScanSecurity(content: string): Promise<SkillScanIssue[]> {
  return transport.call<SkillScanIssue[]>("skills_scan_security", { content })
}

export async function skillsScanResources(
  resources: Array<[string, string]>
): Promise<SkillScanIssue[]> {
  return transport.call<SkillScanIssue[]>("skills_scan_resources", { resources })
}
