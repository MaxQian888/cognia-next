// Thin wrapper around the Claude sidecar IPC. Components should use this
// module rather than touching @tauri-apps/api directly — every boundary
// goes through `transport` from `@/lib/tauri`.

import type { UnlistenFn } from "@tauri-apps/api/event"
import { transport } from "@/lib/tauri"
import type { AgentId, ApprovalDecision, ClaudeEvent, SendContent, SendOptions } from "./types"

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
 */
export async function setProviderEnv(apiKey: string | null, baseUrl: string | null): Promise<void> {
  await transport.call("claude_set_provider_env", { apiKey, baseUrl })
}

export async function hasApiKey(): Promise<boolean> {
  return transport.call<boolean>("claude_has_api_key")
}

/**
 * Push the Claude OAuth bearer (Pro/Max subscription or Console flow) into
 * the in-process Rust state. The sidecar reads this on its next spawn and
 * forwards it as `CLAUDE_CODE_OAUTH_TOKEN` to the agent SDK. Pass `null` to
 * clear; the caller is responsible for triggering a sidecar restart so the
 * change takes effect.
 */
export async function setOauthBearer(token: string | null): Promise<void> {
  await transport.call("claude_set_oauth_bearer", { token })
}

export async function hasOauthBearer(): Promise<boolean> {
  return transport.call<boolean>("claude_has_oauth_bearer")
}

export async function restartSidecar(): Promise<void> {
  await transport.call("claude_restart_sidecar")
}

export async function onClaudeMessage(handler: (evt: ClaudeEvent) => void): Promise<UnlistenFn> {
  return transport.subscribe<ClaudeEvent>(SIDECAR_EVENT, handler)
}

// ---- File-system commands (Skills + MCP import/export) -------------------

export async function readTextFile(path: string): Promise<string> {
  return transport.call<string>("read_text_file", { path })
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await transport.call("write_text_file", { path, content })
}

export async function ensureDir(path: string): Promise<void> {
  await transport.call("ensure_dir", { path })
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

export async function skillsInstallNative(
  request: InstallSkillRequest
): Promise<InstallSkillResponse> {
  return transport.call<InstallSkillResponse>("skills_install_native", { request })
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
 * Spawn the MCP server, walk the JSON-RPC handshake, and report whether it
 * responded plus the discovered tool list. Times out at 10s. Network-transport
 * tests (sse/http) are not yet implemented and return ok: false with a clear
 * error string.
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
