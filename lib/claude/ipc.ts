// Thin wrapper around Tauri's invoke/listen API for the Claude sidecar.
// Components should use this module rather than touching @tauri-apps/api directly.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"
import type { AgentId, ApprovalDecision, ClaudeEvent, SendContent, SendOptions } from "./types"

const SIDECAR_EVENT = "claude://message"

function ensureTauri() {
  if (!isTauri()) {
    throw new Error(
      "Claude IPC is only available inside Tauri. Run `pnpm tauri dev` instead of `pnpm dev`."
    )
  }
}

export async function sendPrompt(
  sessionId: string,
  prompt: SendContent,
  options?: SendOptions
): Promise<void> {
  ensureTauri()
  await invoke("claude_send", { sessionId, prompt, options })
}

export async function interruptSession(sessionId: string): Promise<void> {
  ensureTauri()
  await invoke("claude_interrupt", { sessionId })
}

export async function approveTool(
  sessionId: string,
  requestId: string,
  decision: ApprovalDecision,
  message?: string,
  updatedInput?: unknown
): Promise<void> {
  ensureTauri()
  await invoke("claude_approve", {
    sessionId,
    requestId,
    decision,
    message,
    updatedInput,
  })
}

export async function closeSession(sessionId: string): Promise<void> {
  ensureTauri()
  await invoke("claude_close_session", { sessionId })
}

export async function getSidecarStatus(): Promise<{ ready: boolean }> {
  ensureTauri()
  return invoke<{ ready: boolean }>("claude_sidecar_status")
}

export async function setApiKey(key: string | null): Promise<void> {
  ensureTauri()
  await invoke("claude_set_api_key", { key })
}

export async function hasApiKey(): Promise<boolean> {
  ensureTauri()
  return invoke<boolean>("claude_has_api_key")
}

export async function restartSidecar(): Promise<void> {
  ensureTauri()
  await invoke("claude_restart_sidecar")
}

export function onClaudeMessage(handler: (evt: ClaudeEvent) => void): Promise<UnlistenFn> {
  ensureTauri()
  return listen<ClaudeEvent>(SIDECAR_EVENT, (event) => {
    handler(event.payload)
  })
}

// ---- File-system commands (Skills + MCP import/export) -------------------

export async function readTextFile(path: string): Promise<string> {
  ensureTauri()
  return invoke<string>("read_text_file", { path })
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  ensureTauri()
  await invoke("write_text_file", { path, content })
}

export async function ensureDir(path: string): Promise<void> {
  ensureTauri()
  await invoke("ensure_dir", { path })
}

export async function defaultExportDir(): Promise<string> {
  ensureTauri()
  return invoke<string>("default_export_dir")
}

export interface DiscoveredSkillFile {
  dirName: string
  filePath: string
  content: string
}

export async function scanClaudeSkills(): Promise<DiscoveredSkillFile[]> {
  ensureTauri()
  const raw =
    await invoke<Array<{ dir_name: string; file_path: string; content: string }>>(
      "scan_claude_skills"
    )
  return raw.map((r) => ({
    dirName: r.dir_name,
    filePath: r.file_path,
    content: r.content,
  }))
}

export async function readClaudeUserConfig(): Promise<unknown> {
  ensureTauri()
  return invoke<unknown>("read_claude_user_config")
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
  ensureTauri()
  return invoke<AgentReadResult>("read_agent_config", { agent })
}

export interface AgentWriteResult {
  path: string
  backupPath?: string
}

export async function writeAgentConfig(agent: AgentId, value: unknown): Promise<AgentWriteResult> {
  ensureTauri()
  return invoke<AgentWriteResult>("write_agent_config", { agent, value })
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
  ensureTauri()
  return invoke<NativeSkill[]>("skills_scan_native")
}

export async function skillsScanDir(path: string): Promise<NativeSkill[]> {
  ensureTauri()
  return invoke<NativeSkill[]>("skills_scan_dir", { path })
}

export async function skillsInstallNative(
  request: InstallSkillRequest
): Promise<InstallSkillResponse> {
  ensureTauri()
  return invoke<InstallSkillResponse>("skills_install_native", { request })
}

export async function skillsUninstallNative(
  dirName: string
): Promise<{ removed: boolean; directory: string }> {
  ensureTauri()
  return invoke<{ removed: boolean; directory: string }>("skills_uninstall_native", { dirName })
}

export async function skillsFetchRemoteMd(url: string): Promise<string> {
  ensureTauri()
  return invoke<string>("skills_fetch_remote_md", { url })
}

export async function skillsLoadRegistry(): Promise<RegistrySkillEntry[]> {
  ensureTauri()
  return invoke<RegistrySkillEntry[]>("skills_load_registry")
}

export async function skillsScanSecurity(content: string): Promise<SkillScanIssue[]> {
  ensureTauri()
  return invoke<SkillScanIssue[]>("skills_scan_security", { content })
}

export async function skillsScanResources(
  resources: Array<[string, string]>
): Promise<SkillScanIssue[]> {
  ensureTauri()
  return invoke<SkillScanIssue[]>("skills_scan_resources", { resources })
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
  ensureTauri()
  const raw = await invoke<{
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
