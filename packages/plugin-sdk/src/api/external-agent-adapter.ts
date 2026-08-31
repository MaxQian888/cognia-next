/** Portable contracts for plugin-provided external-agent protocol adapters. */

import type {
  AcpAvailableCommand,
  AcpCapabilities,
  AcpElicitationResponse,
  AcpMcpServerConfig,
  AcpPermissionResponse,
  AcpToolInfo,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentProtocol,
  ExternalAgentResult,
  ExternalAgentSession,
  ExternalAgentTokenUsage,
} from "@/types/agent/external-agent"

export { defineExternalAgentAdapter } from "../define/define-external-agent-adapter"

export type { PluginExternalAgentAdapterDef } from "@/types/plugin/plugin-external-agent-adapter"
export type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentMessageDeltaEvent,
  ExternalAgentProtocol,
  ExternalAgentSession,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"

export interface SessionListOptions {
  cwd?: string
}

export interface SessionCreateOptions {
  cwd?: string
  additionalDirectories?: string[]
  mcpServers?: AcpMcpServerConfig[]
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
  allowedTools?: string[]
  context?: Record<string, unknown>
  instructionEnvelope?: {
    hash: string
    developerInstructions: string
    customInstructions?: string
    skillsSummary?: string
    sourceFlags?: Record<string, boolean>
    projectContextSummary?: string
  }
  systemPrompt?: string
  briefMode?: boolean
  timeout?: number
  metadata?: Record<string, unknown>
}

export interface ProtocolAdapter {
  readonly protocol: string
  readonly connectionStatus: ExternalAgentConnectionStatus
  readonly capabilities?: AcpCapabilities
  readonly tools?: AcpToolInfo[]
  connect(config: ExternalAgentConfig): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession>
  closeSession(sessionId: string): Promise<void>
  prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent>
  execute(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult>
  respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void>
  respondToElicitation?(response: AcpElicitationResponse): Promise<void>
  cancel(sessionId: string): Promise<void>
  getSession(sessionId: string): ExternalAgentSession | undefined
  getSessions(): ExternalAgentSession[]
  healthCheck(): Promise<boolean>
}

export type ProtocolAdapterFactory = () => ProtocolAdapter

export function foldUsageUpdate(
  current: ExternalAgentTokenUsage | undefined,
  event: { used: number; size: number; cost?: { amount: number; currency: string } | null }
): ExternalAgentTokenUsage {
  const base: ExternalAgentTokenUsage = current ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }
  return {
    ...base,
    contextTokens: event.used,
    ...(event.size > 0 ? { modelContextWindow: event.size } : {}),
    ...(base.totalTokens === 0 ? { totalTokens: event.used } : {}),
    ...(event.cost
      ? { providerCost: { amount: event.cost.amount, currency: event.cost.currency } }
      : {}),
  }
}

export function mergeTurnUsage(
  final: ExternalAgentTokenUsage | undefined,
  streamed: ExternalAgentTokenUsage | undefined
): ExternalAgentTokenUsage | undefined {
  if (!final) return streamed
  if (!streamed) return final
  return {
    ...final,
    ...(final.contextTokens === undefined && streamed.contextTokens !== undefined
      ? { contextTokens: streamed.contextTokens }
      : {}),
    ...(final.modelContextWindow === undefined && streamed.modelContextWindow !== undefined
      ? { modelContextWindow: streamed.modelContextWindow }
      : {}),
    ...(final.providerCost === undefined && streamed.providerCost !== undefined
      ? { providerCost: streamed.providerCost }
      : {}),
  }
}

/** Shared lifecycle and turn-folding implementation for plugin adapters. */
export abstract class BaseProtocolAdapter implements ProtocolAdapter {
  abstract readonly protocol: string
  protected _connectionStatus: ExternalAgentConnectionStatus = "disconnected"
  protected _capabilities?: AcpCapabilities
  protected _tools?: AcpToolInfo[]
  protected _config?: ExternalAgentConfig
  protected _sessions = new Map<string, ExternalAgentSession>()

  get connectionStatus(): ExternalAgentConnectionStatus {
    return this._connectionStatus
  }

  get capabilities(): AcpCapabilities | undefined {
    return this._capabilities
  }

  get tools(): AcpToolInfo[] | undefined {
    return this._tools
  }

  abstract connect(config: ExternalAgentConfig): Promise<void>
  abstract disconnect(): Promise<void>
  abstract createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession>
  abstract closeSession(sessionId: string): Promise<void>
  abstract prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent>
  abstract respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void>
  abstract cancel(sessionId: string): Promise<void>
  respondToElicitation?(response: AcpElicitationResponse): Promise<void>

  isConnected(): boolean {
    return this._connectionStatus === "connected"
  }

  getSession(sessionId: string): ExternalAgentSession | undefined {
    return this._sessions.get(sessionId)
  }

  getSessions(): ExternalAgentSession[] {
    return Array.from(this._sessions.values())
  }

  async healthCheck(): Promise<boolean> {
    return this.isConnected()
  }

  async execute(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult> {
    const startedAt = Date.now()
    const messages: ExternalAgentMessage[] = [message]
    const steps: ExternalAgentResult["steps"] = []
    const toolCalls: ExternalAgentResult["toolCalls"] = []
    let currentText = ""
    let currentThinking = ""
    let success = true
    let error: string | undefined
    let finalUsage: ExternalAgentResult["tokenUsage"]
    let streamedUsage: ExternalAgentResult["tokenUsage"]

    try {
      for await (const event of this.prompt(sessionId, message, options)) {
        options?.onEvent?.(event)
        switch (event.type) {
          case "message_delta":
            if (event.delta.type === "text") currentText += event.delta.text
            else if (event.delta.type === "thinking") currentThinking += event.delta.text
            break
          case "tool_use_start":
            toolCalls.push({
              id: event.toolUseId,
              name: event.toolName,
              input: {},
              status: "pending",
            })
            break
          case "tool_use_end": {
            const toolCall = toolCalls.find((candidate) => candidate.id === event.toolUseId)
            if (toolCall) toolCall.input = event.input
            break
          }
          case "tool_result": {
            const toolCall = toolCalls.find((candidate) => candidate.id === event.toolUseId)
            if (toolCall) {
              toolCall.result = event.result
              toolCall.status = event.isError ? "error" : "completed"
              if (event.isError) {
                toolCall.error =
                  typeof event.result === "string" ? event.result : JSON.stringify(event.result)
              }
            }
            break
          }
          case "permission_request":
            if (options?.onPermissionRequest) {
              await this.respondToPermission(
                sessionId,
                await options.onPermissionRequest(event.request)
              )
            }
            break
          case "elicitation_request":
            if (options?.onElicitationRequest && this.respondToElicitation) {
              await this.respondToElicitation(await options.onElicitationRequest(event.request))
            }
            break
          case "plan_update":
            options?.onProgress?.(event.progress)
            break
          case "progress":
            options?.onProgress?.(event.progress, event.message)
            break
          case "error":
            success = false
            error = event.error
            break
          case "usage_update":
            streamedUsage = foldUsageUpdate(streamedUsage, event)
            break
          case "message_end":
            if (event.tokenUsage) streamedUsage = mergeTurnUsage(event.tokenUsage, streamedUsage)
            break
          case "done":
            success = event.success
            if (event.tokenUsage) finalUsage = event.tokenUsage
            break
        }
      }

      if (currentText || currentThinking) {
        messages.push({
          id: this.generateMessageId(),
          role: "assistant",
          content: [
            ...(currentThinking ? [{ type: "thinking" as const, thinking: currentThinking }] : []),
            ...(currentText ? [{ type: "text" as const, text: currentText }] : []),
          ],
          timestamp: new Date(),
        })
      }
      return {
        success,
        sessionId,
        finalResponse: currentText,
        messages,
        steps,
        toolCalls,
        duration: Date.now() - startedAt,
        tokenUsage: mergeTurnUsage(finalUsage, streamedUsage),
        error,
      }
    } catch (cause) {
      return {
        success: false,
        sessionId,
        finalResponse: "",
        messages,
        steps,
        toolCalls,
        duration: Date.now() - startedAt,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }

  protected updateSession(
    sessionId: string,
    updates: Partial<ExternalAgentSession>
  ): ExternalAgentSession | undefined {
    const session = this._sessions.get(sessionId)
    if (!session) return undefined
    const updated = { ...session, ...updates, lastActivityAt: new Date() }
    this._sessions.set(sessionId, updated)
    return updated
  }

  protected generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  protected generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }
}

export const SUPPORTED_EXTERNAL_AGENT_PROTOCOLS = [
  "acp",
  "codex-app-server",
  "dsh-sdk",
  "pi-rpc",
  "opencode",
  "opencode-v2",
  "a2a",
] as const

export interface ExternalAgentExecutionBlockAssessment {
  code: "agent_disabled" | "protocol_unsupported" | "transport_blocked"
  reason: string
  transient?: boolean
}

export function isSupportedExternalAgentProtocol(
  protocol: ExternalAgentProtocol
): protocol is (typeof SUPPORTED_EXTERNAL_AGENT_PROTOCOLS)[number] {
  return SUPPORTED_EXTERNAL_AGENT_PROTOCOLS.includes(
    protocol as (typeof SUPPORTED_EXTERNAL_AGENT_PROTOCOLS)[number]
  )
}

export function getExternalAgentExecutionBlock(
  config: ExternalAgentConfig,
  runtimeSupportsExternalAgents = false
): ExternalAgentExecutionBlockAssessment | null {
  if (!config.enabled) return { code: "agent_disabled", reason: "Agent is disabled." }
  if (!isSupportedExternalAgentProtocol(config.protocol)) {
    return {
      code: "protocol_unsupported",
      reason: config.protocol.includes(":")
        ? `Protocol "${config.protocol}" is provided by a plugin adapter that is not currently registered.`
        : `Protocol "${config.protocol}" is not executable yet.`,
      transient: config.protocol.includes(":"),
    }
  }
  if (config.transport === "stdio" && !runtimeSupportsExternalAgents) {
    return {
      code: "transport_blocked",
      reason: "The stdio transport requires the desktop (Tauri) runtime.",
    }
  }
  return null
}

export function getExternalAgentExecutionBlockReason(
  config: ExternalAgentConfig,
  runtimeSupportsExternalAgents = false
): string | null {
  return getExternalAgentExecutionBlock(config, runtimeSupportsExternalAgents)?.reason ?? null
}

export type PluginProtocolAdapterMetadata = {
  pluginId: string
  adapterId: string
  protocol: string
}

export type ProtocolAdapterRegistryChange = {
  type: "registered" | "unregistered"
  protocol: string
  pluginId?: string
}

/** Command vocabulary is exposed for adapters that surface provider slash commands. */
export type { AcpAvailableCommand }
