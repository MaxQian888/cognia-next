import os from "node:os"

import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type {
  AcpPermissionMode,
  AcpPermissionRequest,
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentExecutionOptions,
  ExternalAgentResult,
} from "@/types/agent/external-agent"
import { getExternalAgentManager, type ExternalAgentManager } from "@/lib/ai/agent/external/manager"
import {
  createAgentFromPreset,
  getPresetConfig,
  resolvePreferredCodexExecutablePresetId,
} from "@/lib/ai/agent/external/presets"
import type { CapturePermissionDecision, CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import { resolveHome } from "../config/load"
import type { ResolvedConfig } from "../config/schema"
import { externalAgentEventToActions } from "../runtime/external/external-event-mapper"
import type { TuiAction } from "../tui/state/types"
import { mintSessionId } from "./run"
import type { AgentSession, SendTurnOptions } from "./session-runner"
import { appendTranscript, type TranscriptFs } from "./transcript"

export interface ExternalAgentSessionManager {
  addAgent(config: ExternalAgentConfig): Promise<unknown>
  execute(
    agentId: string,
    prompt: string,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult>
  setSessionMode(agentId: string, sessionId: string, mode: AcpPermissionMode): Promise<void>
  cancel(agentId: string, sessionId: string): Promise<void>
  removeAgent(agentId: string): Promise<void>
}

export interface ExternalAgentSessionParams {
  config: ResolvedConfig
  sessionId?: string
  sessionKind?: import("@cognia/agent-config-types").SessionKind
  home?: string
  manager?: ExternalAgentSessionManager
  transcriptFs?: TranscriptFs
  now?: () => number
}

export function acpPermissionRequestToCli(
  request: AcpPermissionRequest,
  fallbackSessionId: string
): PermissionRequestEvent {
  return {
    type: "permission_request",
    sessionId: request.sessionId ?? fallbackSessionId,
    requestId: request.requestId ?? request.id,
    toolUseID: request.toolCallId ?? request.id,
    toolName: request.toolInfo.name,
    input: request.rawInput ?? {},
    ...(request.title ? { title: request.title } : {}),
    displayName: request.toolInfo.name,
    ...(request.toolInfo.description ? { description: request.toolInfo.description } : {}),
    ...(request.locations?.[0]?.path ? { blockedPath: request.locations[0].path } : {}),
    ...(request.reason ? { decisionReason: request.reason } : {}),
  }
}

export function captureDecisionToAcp(
  request: AcpPermissionRequest,
  decision: CapturePermissionDecision
): AcpPermissionResponse {
  const granted = decision.decision !== "deny"
  const rememberChoice = decision.decision === "allow_always"
  const wantedKind = granted ? (rememberChoice ? "allow_always" : "allow_once") : "reject_once"
  const optionId = request.options?.find((option) => option.kind === wantedKind)?.optionId
  return {
    requestId: request.requestId ?? request.id,
    granted,
    ...(decision.message ? { reason: decision.message } : {}),
    rememberChoice,
    scope: rememberChoice ? "always" : "once",
    ...(optionId ? { optionId } : {}),
  }
}

function normalizePermissionMode(mode: ResolvedConfig["permissionMode"]): AcpPermissionMode {
  return mode === "auto" ? "default" : mode
}

/** Translate secrets already resolved from ~/.cognia/credentials.json into the
 * environment variables understood by the selected external CLI. */
export function externalAgentCredentialEnv(
  config: ResolvedConfig,
  presetId: string
): Record<string, string> {
  if (presetId === "codex" || presetId === "codex-app-server") {
    const credential = config.providers.codex ?? config.providers.openai
    return {
      ...(credential?.authToken ? { CODEX_ACCESS_TOKEN: credential.authToken } : {}),
      ...(credential?.apiKey
        ? { OPENAI_API_KEY: credential.apiKey, CODEX_API_KEY: credential.apiKey }
        : {}),
    }
  }
  if (presetId === "claude-code") {
    const credential = config.providers.anthropic
    return {
      ...(credential?.authToken ? { CLAUDE_CODE_OAUTH_TOKEN: credential.authToken } : {}),
      ...(credential?.apiKey ? { ANTHROPIC_API_KEY: credential.apiKey } : {}),
      ...(credential?.baseURL ? { ANTHROPIC_BASE_URL: credential.baseURL } : {}),
    }
  }
  return {}
}

function usageFromResult(result: ExternalAgentResult) {
  if (!result.tokenUsage) return undefined
  return {
    inputTokens: result.tokenUsage.promptTokens,
    outputTokens: result.tokenUsage.completionTokens,
    ...(result.tokenUsage.cacheReadTokens === undefined
      ? {}
      : { cacheReadInputTokens: result.tokenUsage.cacheReadTokens }),
    ...(result.tokenUsage.cacheWriteTokens === undefined
      ? {}
      : { cacheCreationInputTokens: result.tokenUsage.cacheWriteTokens }),
    durationMs: result.duration,
  }
}

function actionToCaptureEvent(action: TuiAction): CaptureStreamEvent | undefined {
  switch (action.type) {
    case "INFLIGHT_TEXT":
      return { type: "text-delta", delta: action.delta }
    case "INFLIGHT_THINKING":
      return { type: "thinking-delta", delta: action.delta }
    case "TOOL_CALL":
      return {
        type: "tool-call",
        id: action.callKey,
        toolName: action.toolName,
        input: action.input,
      }
    case "TOOL_RESULT":
      return {
        type: "tool-result",
        ...(action.callKey ? { id: action.callKey } : {}),
        toolName: action.toolName,
        ...(action.input ? { input: action.input } : {}),
        result: action.result,
        ...(action.isError ? { isError: true } : {}),
      }
    case "SET_USAGE":
      return { type: "usage", usage: action.usage, partial: false }
    default:
      return undefined
  }
}

/** Create a persistent external-agent session with the same interface as the built-in sidecar. */
export function createExternalAgentSession(params: ExternalAgentSessionParams): AgentSession {
  const backend = params.config.agentBackend ?? "builtin"
  if (backend === "builtin" || !getPresetConfig(backend)) {
    throw new Error(
      backend === "builtin"
        ? "createExternalAgentSession requires an external backend"
        : `Unknown external-agent backend: ${backend}`
    )
  }

  const now = params.now ?? Date.now
  const sessionId = params.sessionId ?? mintSessionId(now())
  const agentId = `cli-external-${sessionId}`
  const home = params.home ?? resolveHome(process.env, os.homedir())
  // A desktop-lived health interval would keep a completed CLI process alive.
  // CLI sessions connect lazily per turn and remove their agent on close, so no
  // background poller is needed.
  const manager =
    params.manager ?? (getExternalAgentManager({ healthCheckInterval: 0 }) as ExternalAgentManager)
  let initialized = false
  let closed = false
  let externalSessionId: string | undefined
  let permissionMode = normalizePermissionMode(params.config.permissionMode)

  const ensureAgent = async (): Promise<void> => {
    if (initialized) return
    const presetId = backend === "codex" ? await resolvePreferredCodexExecutablePresetId() : backend
    const config = createAgentFromPreset(presetId, {
      id: agentId,
      enabled: true,
      defaultPermissionMode: permissionMode,
      timeout: params.config.streamIdleTimeoutMs || undefined,
    })
    if (!config) throw new Error(`Unknown external-agent backend: ${presetId}`)
    if (config.process) {
      config.process = {
        ...config.process,
        cwd: params.config.cwd,
        env: {
          ...config.process.env,
          ...externalAgentCredentialEnv(params.config, presetId),
        },
      }
    }
    await manager.addAgent(config)
    initialized = true
  }

  return {
    sessionId,
    async send(prompt: string, opts: SendTurnOptions) {
      if (closed) throw new Error("agent session is closed")
      await ensureAgent()
      appendTranscript(
        home,
        sessionId,
        { role: "user", content: prompt },
        params.transcriptFs,
        now()
      )

      const result = await manager.execute(agentId, prompt, {
        ...(externalSessionId ? { sessionId: externalSessionId } : {}),
        ...(params.config.model ? { model: params.config.model } : {}),
        ...(params.config.systemPrompt ? { systemPrompt: params.config.systemPrompt } : {}),
        permissionMode,
        ...(params.config.allowedTools ? { allowedTools: params.config.allowedTools } : {}),
        // ACP session/new requires the field even when no MCP servers are
        // forwarded. Keep v1 intentionally empty rather than leaking the
        // built-in sidecar's unrelated MCP configuration into the child.
        context: { custom: { mcpServers: [] } },
        workingDirectory: params.config.cwd,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        onPermissionRequest: async (request) => {
          const decision = await opts.gate(acpPermissionRequestToCli(request, sessionId))
          return captureDecisionToAcp(request, decision)
        },
        onEvent: (event) => {
          for (const action of externalAgentEventToActions(event)) {
            if (opts.onAction) {
              opts.onAction(action)
            } else {
              const capture = actionToCaptureEvent(action)
              if (capture) opts.onEvent?.(capture)
            }
          }
        },
      })

      externalSessionId = result.sessionId
      if (!result.success) throw new Error(result.error || "External agent execution failed")
      const usage = usageFromResult(result)
      appendTranscript(
        home,
        sessionId,
        {
          role: "assistant",
          content: result.finalResponse,
          meta: {
            backend,
            ...(params.config.model ? { model: params.config.model } : {}),
            ...(usage ? { usage } : {}),
          },
        },
        params.transcriptFs,
        now()
      )
      return {
        text: result.finalResponse,
        messageId: `external-${now()}`,
        sessionId,
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
        ...(usage ? { usage } : {}),
      }
    },
    async setPermissionMode(mode) {
      permissionMode = normalizePermissionMode(mode)
      if (initialized && externalSessionId) {
        await manager.setSessionMode(agentId, externalSessionId, permissionMode)
      }
    },
    isLive() {
      return initialized && !closed
    },
    async close() {
      if (closed) return
      closed = true
      if (!initialized) return
      if (externalSessionId) {
        try {
          await manager.cancel(agentId, externalSessionId)
        } catch {
          // The turn may already be complete; removal below is authoritative cleanup.
        }
      }
      await manager.removeAgent(agentId)
    },
  }
}
