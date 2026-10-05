/**
 * The shared base for external-agent protocol adapters (ADR-0217).
 *
 * Holds what every adapter would otherwise re-implement: connection status,
 * the session cache, the collect-all `execute()` over `prompt()`, and the
 * command-advertised compaction/undo routes. Protocol specifics stay in the
 * subclasses, which live in their integration packages.
 */

import { contentBlocksText, externalContentFromBlock } from "./content-blocks"
import type {
  ExternalAgentAdapterCore,
  SessionCreateOptions,
  SessionRegistryCapability,
} from "@cognia/agent-contracts/adapter"
import type {
  AcpAvailableCommand,
  AcpCapabilities,
  AcpContentBlock,
  AcpElicitationResponse,
  AcpPermissionResponse,
  AcpToolInfo,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentResult,
  ExternalAgentSession,
  ExternalAgentTokenUsage,
} from "@cognia/agent-contracts/external-agent"
import {
  resolveCommandCompactionCapability,
  resolveProviderUndoCapability,
  type ExternalAgentCompactionCapability,
  type ExternalAgentCompactionOptions,
  type ExternalAgentProviderUndoCapability,
  type ExternalAgentSessionInputQueue,
} from "@cognia/agent-contracts/session-operations"

/**
 * Fold a context-window `usage_update` into the running usage.
 *
 * The protocol reports OCCUPANCY (`used` / `size`) and a cumulative cost, not a
 * prompt/completion split — see `canonical-contract.ts`. So `used` becomes
 * `contextTokens`, `size` becomes the window, and `totalTokens` is only filled
 * when nothing better has arrived: overwriting a real breakdown with an
 * occupancy figure would silently halve a caller's token accounting.
 *
 * Agents that DO report accounting (Devin's `cognition.ai/*` usage meta) attach
 * a turn-relative `tokenUsage` — those figures win outright: each observation
 * is cumulative-within-the-turn, so the latest replaces rather than sums.
 */
export function foldUsageUpdate(
  current: ExternalAgentTokenUsage | undefined,
  event: {
    used: number
    size: number
    cost?: { amount: number; currency: string } | null
    tokenUsage?: ExternalAgentTokenUsage
  }
): ExternalAgentTokenUsage {
  const base: ExternalAgentTokenUsage = current ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }
  const live = event.tokenUsage
  const totalTokens = live?.totalTokens ?? base.totalTokens
  return {
    ...base,
    promptTokens: live?.promptTokens ?? base.promptTokens,
    completionTokens: live?.completionTokens ?? base.completionTokens,
    totalTokens: totalTokens === 0 ? event.used : totalTokens,
    ...(live?.reasoningTokens === undefined ? {} : { reasoningTokens: live.reasoningTokens }),
    ...(live?.cacheReadTokens === undefined ? {} : { cacheReadTokens: live.cacheReadTokens }),
    ...(live?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: live.cacheWriteTokens }),
    contextTokens: event.used,
    ...(event.size > 0 ? { modelContextWindow: event.size } : {}),
    // `event.cost` is the CUMULATIVE session figure; a per-turn delta carried
    // by the vendor tokenUsage wins over it for turn accounting.
    ...(event.cost
      ? { providerCost: { amount: event.cost.amount, currency: event.cost.currency } }
      : {}),
    ...(live?.providerCost === undefined ? {} : { providerCost: live.providerCost }),
  }
}

/**
 * The turn's usage: the terminal figure when there is one, otherwise the last
 * streamed one.
 *
 * Not a deep merge. When `done` reports usage it is the adapter's final,
 * authoritative accounting and must not be diluted by an earlier partial —
 * except for the two fields `done` structurally cannot carry on some adapters
 * (the live context window, and a provider-reported cost that only ever
 * arrives on a `usage_update`), which are carried forward when the final
 * figure is silent about them.
 */
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

/**
 * Base class for protocol adapters providing common functionality.
 */
export abstract class BaseProtocolAdapter
  implements ExternalAgentAdapterCore, SessionRegistryCapability
{
  respondToElicitation?(response: AcpElicitationResponse): Promise<void>
  abstract readonly protocol: string

  protected _connectionStatus: ExternalAgentConnectionStatus = "disconnected"
  protected _capabilities?: AcpCapabilities
  protected _tools?: AcpToolInfo[]
  protected _config?: ExternalAgentConfig
  protected _sessions: Map<string, ExternalAgentSession> = new Map()

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
  abstract cancel(sessionId: string): Promise<void | ExternalAgentSessionInputQueue>

  isConnected(): boolean {
    return this._connectionStatus === "connected"
  }

  getSession(sessionId: string): ExternalAgentSession | undefined {
    return this._sessions.get(sessionId)
  }

  getSessions(): ExternalAgentSession[] {
    return Array.from(this._sessions.values())
  }

  /**
   * Drop every session this adapter remembers.
   *
   * These ids name state inside an agent PROCESS. When that process is gone
   * the ids are gone with it, so a reconnect to a fresh process must not be
   * able to hand one back as a session to resume. `disconnect()` already
   * clears them on the paths it owns; this is for the ones it does not, where
   * the process died on its own and the adapter is reused as-is.
   */
  forgetSessions(): void {
    this._sessions.clear()
  }

  async healthCheck(): Promise<boolean> {
    return this.isConnected()
  }

  protected async getAdvertisedCommandCompactionCapability(
    sessionId: string
  ): Promise<ExternalAgentCompactionCapability> {
    const session = this.getSession(sessionId)
    if (!session) {
      return { status: "unknown", routes: [], reason: "session_not_found" }
    }
    return resolveCommandCompactionCapability(
      (session.metadata?.availableCommands as AcpAvailableCommand[] | undefined) ?? []
    )
  }

  protected async compactWithAdvertisedCommand(
    sessionId: string,
    options: ExternalAgentCompactionOptions = {}
  ): Promise<void> {
    const capability = await this.getAdvertisedCommandCompactionCapability(sessionId)
    const route = capability.routes.find(
      (candidate) => candidate.kind === "command" && (!options.focus || candidate.supportsFocus)
    )
    if (!route || route.kind !== "command") {
      throw new Error("Agent does not support context compaction")
    }
    const text = options.focus ? `/${route.command} ${options.focus}` : `/${route.command}`
    const result = await this.execute(sessionId, {
      id: this.generateMessageId(),
      role: "user",
      content: [{ type: "text", text }],
      timestamp: new Date(),
    })
    if (!result.success) {
      throw new Error(result.error || "Context compaction failed")
    }
  }

  protected async getAdvertisedProviderUndoCapability(
    sessionId: string
  ): Promise<ExternalAgentProviderUndoCapability> {
    const session = this.getSession(sessionId)
    if (!session) {
      return { status: "unknown", reason: "session_not_found" }
    }
    return resolveProviderUndoCapability(
      (session.metadata?.availableCommands as AcpAvailableCommand[] | undefined) ?? []
    )
  }

  protected async undoWithAdvertisedCommand(sessionId: string): Promise<void> {
    const capability = await this.getAdvertisedProviderUndoCapability(sessionId)
    if (capability.status !== "supported") {
      throw new Error("Agent does not support provider undo")
    }
    const result = await this.execute(sessionId, {
      id: this.generateMessageId(),
      role: "user",
      content: [{ type: "text", text: "/undo" }],
      timestamp: new Date(),
    })
    if (!result.success) {
      throw new Error(result.error || "Provider undo failed")
    }
  }

  /**
   * Execute a complete interaction by collecting all events from prompt
   */
  async execute(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult> {
    const startTime = Date.now()
    const events: ExternalAgentEvent[] = []
    const messages: ExternalAgentMessage[] = [message]
    const steps: ExternalAgentResult["steps"] = []
    const toolCalls: ExternalAgentResult["toolCalls"] = []

    let currentText = ""
    let currentThinking = ""
    const artifacts = new Map<string, AcpContentBlock[]>()
    let success = true
    let error: string | undefined
    // Two sources, deliberately kept apart until the end. `done` carries the
    // authoritative final figure when an adapter has one; the streaming
    // `usage_update` / `message_end` events are the running one. Reading only
    // `done` (which is what this used to do) meant every adapter that reports
    // usage mid-stream and settles without repeating it — OpenCode, and any
    // ACP agent that sends `usage_update` — returned a result with no usage at
    // all, while the events the caller had just seen carried it.
    let finalUsage: ExternalAgentResult["tokenUsage"]
    let streamedUsage: ExternalAgentResult["tokenUsage"]

    try {
      for await (const event of this.prompt(sessionId, message, options)) {
        events.push(event)

        // Call event callback if provided
        options?.onEvent?.(event)

        switch (event.type) {
          case "artifact_update":
            artifacts.set(event.artifactId, event.blocks)
            break
          case "message_delta":
            if (event.delta.type === "text") {
              currentText += event.delta.text
            } else if (event.delta.type === "thinking") {
              currentThinking += event.delta.text
            }
            break

          case "tool_use_start":
            toolCalls.push({
              id: event.toolUseId,
              name: event.toolName,
              input: {},
              status: "pending",
            })
            break

          case "tool_use_end":
            {
              const toolCall = toolCalls.find((tc) => tc.id === event.toolUseId)
              if (toolCall) {
                toolCall.input = event.input
              }
            }
            break

          case "tool_result":
            {
              const toolCall = toolCalls.find((tc) => tc.id === event.toolUseId)
              if (toolCall) {
                toolCall.result = event.result
                toolCall.status = event.isError ? "error" : "completed"
                if (event.isError) {
                  toolCall.error =
                    typeof event.result === "string" ? event.result : JSON.stringify(event.result)
                }
              }
            }
            break

          case "permission_request":
            if (options?.onPermissionRequest) {
              const response = await options.onPermissionRequest(event.request)
              await this.respondToPermission(sessionId, response)
            }
            break

          case "elicitation_request":
            if (options?.onElicitationRequest && this.respondToElicitation) {
              const response = await options.onElicitationRequest(event.request)
              await this.respondToElicitation(response)
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
            // A context-window report. It carries occupancy rather than a
            // prompt/completion split, so it can only FILL what nothing else
            // has said — never overwrite a real breakdown with zeros.
            streamedUsage = foldUsageUpdate(streamedUsage, event)
            break

          case "message_end":
            // Folded, not assigned. `message_end` carries a prompt/completion
            // breakdown and, on several adapters, nothing else — so replacing
            // outright discards the live context window and the provider cost a
            // preceding `usage_update` had already established. `mergeTurnUsage`
            // is the same rule applied at the end of the turn: the newer
            // accounting wins, the fields it structurally cannot carry survive.
            if (event.tokenUsage) {
              streamedUsage = mergeTurnUsage(event.tokenUsage, streamedUsage)
            }
            break

          case "done":
            // A `done` frame cannot un-say a refusal the agent already
            // reported and never answered. Pi settles EVERY turn with
            // `agent_settled` -> `done{success: true}`, including one whose
            // `message_end` carried `stopReason: "error"` (an insufficient
            // balance, a model outside the plan). Taking `done` at its word
            // there overwrote the failure and returned a successful turn with
            // an empty `finalResponse`, so the CLI printed nothing at all and
            // exited 0, and a headless `run` reported no error to report.
            //
            // Narrow on purpose: only a turn that produced NO assistant text
            // is downgraded. An agent that hits a recoverable error, retries
            // and then answers still settles as the success it is.
            success =
              event.success &&
              !(
                error !== undefined &&
                currentText === "" &&
                ![...artifacts.values()].some((blocks) => blocks.length > 0)
              )
            if (event.tokenUsage) finalUsage = event.tokenUsage
            break
        }
      }

      const artifactBlocks = [...artifacts.values()].flat()
      // Build final response message, retaining binary bodies and replacements.
      if (currentText || currentThinking || artifactBlocks.length) {
        messages.push({
          id: `msg_${Date.now()}`,
          role: "assistant",
          content: [
            ...(currentThinking ? [{ type: "thinking" as const, thinking: currentThinking }] : []),
            ...(currentText ? [{ type: "text" as const, text: currentText }] : []),
            ...artifactBlocks.map(externalContentFromBlock),
          ],
          timestamp: new Date(),
        })
      }

      return {
        success,
        sessionId,
        finalResponse: currentText + contentBlocksText(artifactBlocks),
        messages,
        steps,
        toolCalls,
        duration: Date.now() - startTime,
        tokenUsage: mergeTurnUsage(finalUsage, streamedUsage),
        error,
      }
    } catch (err) {
      return {
        success: false,
        sessionId,
        finalResponse: "",
        messages,
        steps,
        toolCalls,
        duration: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Update session in the map
   */
  protected updateSession(
    sessionId: string,
    updates: Partial<ExternalAgentSession>
  ): ExternalAgentSession | undefined {
    const session = this._sessions.get(sessionId)
    if (session) {
      const updated = { ...session, ...updates, lastActivityAt: new Date() }
      this._sessions.set(sessionId, updated)
      return updated
    }
    return undefined
  }

  /**
   * Generate a unique session ID
   */
  protected generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * Generate a unique message ID
   */
  protected generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }
}
