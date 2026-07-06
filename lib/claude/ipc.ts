// Thin wrapper around the Claude sidecar IPC. Components should use this
// module rather than touching @tauri-apps/api directly — every boundary
// goes through `transport` from `@/lib/tauri`.

import type { UnlistenFn } from "@tauri-apps/api/event"
import type { UIMessage } from "@/types"
import { transport } from "@/lib/tauri"
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
  SessionControlMethod,
} from "./types"
import {
  isControlResponseEvent,
  isPluginToolExecEvent,
  isProtocolAdapterCancelEvent,
} from "./types"
import type { PluginToolExecResponse } from "./plugin-tool-ipc"
import type { ProtocolAdapterExecEvent } from "./protocol-adapter-ipc"
import type { ProtocolAdapterCancelEvent } from "./types"

const SIDECAR_EVENT = "claude://message"

export async function sendPrompt(
  sessionId: string,
  prompt: SendContent,
  options?: SendOptions
): Promise<void> {
  await transport.call("claude_send", { sessionId, prompt, options })
}

export async function interruptSession(sessionId: string): Promise<void> {
  await transport.call("claude_interrupt", { sessionId })
}

/**
 * Manually compact a running session's context. Mirrors {@link interruptSession}
 * — a fire-and-forget control message routed to the sidecar. On the generic
 * (AI-SDK) path the sidecar runs a summary round-trip now; on the Anthropic
 * path it pushes a `/compact` turn the Agent SDK intercepts. `focus` is the
 * optional compact-instruction argument (e.g. from `/compact <focus>`).
 */
export async function compactSession(sessionId: string, focus?: string): Promise<void> {
  await transport.call("claude_compact", { sessionId, focus })
}

/**
 * Undo a prior compaction by restoring the pre-compaction message snapshot.
 * Mirrors {@link compactSession}: a fire-and-forget control message. `messages`
 * is the sidecar-format snapshot captured on the `compact_boundary` event
 * (`compact_metadata.pre_messages`) — NOT renderer UIMessages. Only valid on the
 * generic (AI-SDK) path while the session is still live and idle.
 */
export async function restoreSession(sessionId: string, messages: unknown[]): Promise<void> {
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
  mode: NonNullable<SendOptions["permissionMode"]>
): Promise<void> {
  await transport.call("claude_set_mode", { sessionId, mode })
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
      if (!isControlResponseEvent(evt)) return
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
export async function sessionControl<T = unknown>(
  sessionId: string,
  method: SessionControlMethod,
  params?: Record<string, unknown>
): Promise<T> {
  // Await the subscription before firing so a fast reply can't race the listener.
  await ensureControlListener()
  const requestId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControl.delete(requestId)
      reject(new Error(`control "${method}" timed out`))
    }, CONTROL_TIMEOUT_MS)
    pendingControl.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    })
    transport
      .call("claude_session_control", { sessionId, requestId, method, params })
      .catch((err) => {
        const pending = pendingControl.get(requestId)
        if (!pending) return
        pendingControl.delete(requestId)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

/** Live context-window usage from the SDK (authoritative window + breakdown). */
export function getSessionContextUsage(sessionId: string): Promise<SdkContextUsage> {
  return sessionControl<SdkContextUsage>(sessionId, "getContextUsage")
}

/** Live MCP client status for the running session (one entry per server). */
export function getSessionMcpStatus(sessionId: string): Promise<SdkMcpServerStatus[]> {
  return sessionControl<SdkMcpServerStatus[]>(sessionId, "mcpServerStatus")
}

/** Reconnect a failed/needs-auth MCP server on the running session. */
export function reconnectSessionMcpServer(sessionId: string, name: string): Promise<void> {
  return sessionControl<void>(sessionId, "reconnectMcpServer", { name })
}

/** Enable/disable an MCP server on the running session. */
export function toggleSessionMcpServer(
  sessionId: string,
  name: string,
  enabled: boolean
): Promise<unknown> {
  return sessionControl<unknown>(sessionId, "toggleMcpServer", { name, enabled })
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
export function setSessionModel(sessionId: string, model: string): Promise<void> {
  return sessionControl<void>(sessionId, "setModel", { model })
}

// ---- Mobile-only message + session RPCs (mobile completeness Phase 2) ----

/**
 * Page of sessions returned by `session_list`. Sorted desktop-side by
 * `updatedAt` descending. `next_offset` is set when more rows remain
 * after `offset + rows.length`.
 */
export interface SessionListPage {
  rows: ChatSession[]
  total: number
  next_offset?: number
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
 * Tauri command → `messageRepository.list`.
 *
 * Returns rows sorted by `createdAt` ascending so the mobile client can
 * append them to its scrollback in order.
 */
export interface MobileMessagesPage {
  rows: UIMessage[]
  total: number
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
  updatedInput?: unknown
): Promise<void> {
  await transport.call("claude_approve", {
    sessionId,
    requestId,
    decision,
    message,
    updatedInput,
  })
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
  updatedToolOutput?: unknown
): Promise<void> {
  await transport.call("claude_tool_result_decision", {
    sessionId,
    reviewId,
    updatedToolOutput,
  })
}

export async function closeSession(sessionId: string): Promise<void> {
  await transport.call("claude_close_session", { sessionId })
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
  return transport.subscribe<ClaudeEvent>(SIDECAR_EVENT, handler)
}

/**
 * Subscribe to `plugin_tool_exec` events on the sidecar channel and forward
 * them to `handler` (which runs the tool via `handlePluginToolExec` and writes
 * the result back with `sendPluginToolResponse`). Reuses the single
 * `onClaudeMessage` subscription + the `ClaudeEvent` type guard. No-op in web.
 */
export async function subscribePluginToolExec(
  handler: (req: PluginToolExecEvent) => void
): Promise<UnlistenFn> {
  return onClaudeMessage((evt) => {
    if (isPluginToolExecEvent(evt)) handler(evt)
  })
}

/**
 * Write a `plugin_tool_response` back onto the sidecar stdin so the pending
 * `pendingPluginToolCalls` entry resolves. Mirrors `approveTool`/`claude_approve`.
 */
export async function sendPluginToolResponse(resp: PluginToolExecResponse): Promise<void> {
  await transport.call("claude_plugin_tool_response", {
    sessionId: resp.sessionId,
    toolUseId: resp.toolUseId,
    result: resp.result,
    error: resp.error,
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
export async function sendProtocolAdapterMessage(message: Record<string, unknown>): Promise<void> {
  await transport.call("claude_protocol_adapter_message", { message })
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

export interface SkillScanIssue {
  severity: "low" | "medium" | "high"
  kind: string
  message: string
  line?: number
}

export async function skillsScanNative(): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_native")
}

export async function skillsScanDir(path: string): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_dir", { path })
}

export async function skillsScanCodex(): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_codex")
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

// ---- MCP server health-check / tool discovery ----------------------------

export interface McpToolInfo {
  name: string
  description?: string
}

export interface McpTestResult {
  ok: boolean
  toolCount: number
  tools: McpToolInfo[]
  error?: string
  durationMs: number
}

export interface McpTestRequest {
  transport: "stdio" | "sse" | "http"
  /** stdio only — the executable to spawn. */
  command?: string
  /** stdio only — argv after the executable. */
  args?: string[]
  /** stdio only — environment overrides. */
  env?: Record<string, string>
  /** sse / http only — endpoint URL. */
  url?: string
  /** sse / http only — extra request headers. */
  headers?: Record<string, string>
}

/**
 * Probe an MCP server and report whether it responded plus the discovered
 * tool list. Times out at 10s.
 *
 *   - `stdio`: spawn the executable, walk the JSON-RPC handshake.
 *   - `http`:  open a streamable-HTTP session, run `initialize` + `tools/list`.
 *   - `sse`:   open the SSE endpoint, run the same handshake over the stream.
 *
 * Per-transport implementations live in `src-tauri/src/claude/mcp_test.rs`.
 * Errors are normalised to a single `error` string so the UI can render any
 * failure mode without branching on transport.
 */
export async function testMcpServer(req: McpTestRequest): Promise<McpTestResult> {
  const raw = await transport.call<{
    ok: boolean
    tool_count: number
    tools: { name: string; description?: string | null }[]
    error?: string | null
    duration_ms: number
  }>("test_mcp_server", { ...req })
  return {
    ok: raw.ok,
    toolCount: raw.tool_count,
    tools: raw.tools.map((t) => ({
      name: t.name,
      description: t.description ?? undefined,
    })),
    error: raw.error ?? undefined,
    durationMs: raw.duration_ms,
  }
}
