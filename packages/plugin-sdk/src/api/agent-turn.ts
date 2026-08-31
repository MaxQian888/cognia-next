import type { SendOptions } from "@cognia/agent-config-types"

export interface PluginAgentTurnRequest {
  characterId: string
  prompt: string
  cwd: string
  sessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
  permissionMode?: SendOptions["permissionMode"]
}

export interface PluginAgentTurnResult {
  sessionId: string
  text: string
  messageId?: string
}

export class PluginAgentTurnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginAgentTurnError"
  }
}

export interface PluginSeededSessionInput {
  title?: string
  characterId?: string
  projectId?: string
  workingDir?: string
  seedUserMessage?: string
}

export interface PluginSeededSessionResult {
  sessionId: string
}

/** Runtime calls are governed through `ctx.agent` and `ctx.session`. */
