import type { SendOptions } from "@cognia/agent-config-types"
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"

export interface PluginAgentTurnRequest {
  characterId: string
  prompt: string
  cwd: string
  sessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
  permissionMode?: SendOptions["permissionMode"]
  /**
   * Composition this turn runs under (preset, authority, tool presentation…).
   * Absent keeps the session's own selection. It is the caller's, not the
   * desktop composer's, so an unattended turn never inherits whatever the user
   * last clicked.
   */
  composition?: AgentCompositionSelectionV1
  /**
   * Per-turn capability grants, outermost first: extra skills, MCP servers,
   * knowledge bases, instructions, tool additions and denials, a permission cap.
   * The host validates each one and applies it inside the send-option resolver,
   * so the agent's tool filter and Restricted Mode still clamp it. The host
   * stamps the calling plugin as each grant's source.
   */
  capabilityGrants?: AgentCapabilityGrantV1[]
}

/** One tool request the unattended turn had to turn away. */
export interface PluginAgentTurnDenial {
  requestId: string
  toolName: string
  /** Wall-clock ms when the denial was issued. */
  at: number
  /** The message the model was given. */
  reason: string
}

export interface PluginAgentTurnResult {
  sessionId: string
  text: string
  messageId?: string
  /**
   * `completed` when the turn ended on its own terms. `needs_approval` when
   * at least one tool asked for a permission this unattended turn could not
   * grant: the request was denied immediately, the model was told, and
   * `needsApproval` lists what a human still has to decide. A turn run with
   * `permissionMode: "bypassPermissions"` never asks, so it is always
   * `completed`.
   */
  status: "completed" | "needs_approval"
  /** Present, and non-empty, exactly when `status` is `needs_approval`. */
  needsApproval?: PluginAgentTurnDenial[]
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
