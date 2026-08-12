import { transport } from "@/lib/tauri/transport-instance"

export type CodexAppTurnInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "localImage"; path: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string }

export interface CodexAppThread {
  id: string
  sessionId: string
  parentThreadId: string | null
  preview: string
  name: string | null
  cwd: string
  createdAt: number
  updatedAt: number
  status: { type: string; activeFlags?: string[] }
  turns: unknown[]
}

export interface CodexAppTaskPage {
  data: CodexAppThread[]
  nextCursor: string | null
}

export interface CodexAppInventory {
  plugins: unknown
  skills: unknown
  mcpServers: unknown
}

export interface CodexAppRuntimeStatus {
  ready: boolean
  mode: "normal-app-cdp-rollout-mirror"
  restartSupported?: boolean
  error?: string
}

export function getCodexAppRuntimeStatus(): Promise<CodexAppRuntimeStatus> {
  return transport.call("codex_app_runtime_status")
}

export function listCodexAppTasks(
  request: {
    cursor?: string
    limit?: number
    searchTerm?: string
    cwd?: string
    archived?: boolean
  } = {}
): Promise<CodexAppTaskPage> {
  return transport.call("codex_app_task_list", { request })
}

export function readCodexAppTask(
  threadId: string,
  includeTurns = true
): Promise<{ thread: CodexAppThread }> {
  return transport.call("codex_app_task_read", { request: { threadId, includeTurns } })
}

export function createCodexAppTask(request: {
  cwd: string
  input: CodexAppTurnInput[]
  browserUrl?: string
}): Promise<{ thread: CodexAppThread }> {
  return transport.call("codex_app_task_create", { request })
}

export function sendCodexAppTask(request: {
  threadId: string
  input: CodexAppTurnInput[]
  contextLabel?: string
}): Promise<{ turn: { id: string } }> {
  return transport.call("codex_app_task_send", { request })
}

export function interruptCodexAppTask(
  threadId: string,
  turnId: string
): Promise<{ threadId: string; interrupted: boolean; reason: string | null }> {
  return transport.call("codex_app_task_interrupt", { request: { threadId, turnId } })
}

export function openCodexAppTask(
  threadId: string
): Promise<{ threadId: string; deepLink: string }> {
  return transport.call("codex_app_task_open", { threadId })
}

export function getCodexAppInventory(
  request: {
    cwd?: string
    forceReload?: boolean
    threadId?: string
  } = {}
): Promise<CodexAppInventory> {
  return transport.call("codex_app_inventory", { request })
}
