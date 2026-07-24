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
import {
  RunAndCaptureError,
  type CapturePermissionDecision,
  type CaptureStreamEvent,
} from "@/lib/claude/run-and-capture"

import type { McpServer } from "@cognia/agent-config-types"
import type { AcpMcpServerConfig } from "@/types/agent/external-agent"

import { resolveHome } from "../config/load"
import { loadMcpServers } from "../mcp/load-mcp-config"
import { applyDisabled, readDisabled } from "../mcp/mcp-state"
import { toAcpMcpServers } from "../tui/runtime/backend-bridge"
import type { ResolvedConfig } from "../config/schema"
import { externalAgentEventToActions } from "../runtime/external/external-event-mapper"
import type { TuiAction } from "../tui/state/types"
import { createIdleWatchdog } from "./idle-watchdog"
import { isResumableLink, readExternalLink, writeExternalLink } from "./external-session-link"
import { mintSessionId } from "./run"
import type { AgentSession, SendTurnOptions } from "./session-runner"
import { appendTranscript, type TranscriptFs } from "./transcript"

/**
 * The wall-clock budget handed to the shared manager for one turn.
 *
 * The manager wraps `adapter.execute` in a hard wall-clock timeout and its
 * `resolveExecutionTimeoutMs` treats any value `<= 0` as "unset" — falling back
 * to a 5-minute default — so there is no way to ask it for "no wall clock".
 * A day is the practical equivalent (and stays well inside the ~24.8-day
 * `setTimeout` ceiling). The REAL bound on a turn is the idle watchdog below,
 * which matches what the built-in sidecar path does: a long agentic turn is
 * legitimate, silence is not.
 */
const EXTERNAL_TURN_WALL_CLOCK_MS = 24 * 60 * 60 * 1000

/**
 * Budget for spawning the process and completing the protocol handshake. Unlike
 * a turn, a handshake that hangs is never legitimate, so this one stays tight.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000

/**
 * Connect/handshake budget. `streamIdleTimeoutMs` is a per-turn *stream* bound
 * and may legitimately be `0` ("disable the watchdog") — which must NOT leak
 * into the connect path as "unset" and land on the preset's stricter 30s
 * default. Falling back explicitly keeps disabling the watchdog from making
 * startup *stricter*.
 */
export function resolveConnectTimeoutMs(config: ResolvedConfig): number {
  const configured = config.streamIdleTimeoutMs
  return typeof configured === "number" && configured > 0 ? configured : DEFAULT_CONNECT_TIMEOUT_MS
}

/** Per-turn silence budget. `0` (or unset-to-0) disables the watchdog. */
function resolveIdleTimeoutMs(config: ResolvedConfig): number {
  const configured = config.streamIdleTimeoutMs
  return typeof configured === "number" ? configured : DEFAULT_CONNECT_TIMEOUT_MS
}

/** Message fragments that mean the agent PROCESS or its connection is gone. */
const AGENT_GONE =
  /\b(?:spawn|enoent|epipe|econnreset|killed|exited|not connected|disconnected|connection closed|agent not found)\b/i

/**
 * Classify an external failure into the {@link RunAndCaptureError} code the turn
 * engine already understands.
 *
 * `session_error` keeps the session — and with it the external agent's
 * accumulated context — alive; `sidecar_exited` tells the caller to tear it down
 * and respawn. Defaulting to `session_error` is the load-bearing half: a plain
 * `Error` carries no code, so every external failure used to read as "the
 * session is dead", silently discarding the whole conversation for something as
 * small as one refused tool call.
 */
export function classifyExternalFailure(
  message: string,
  errorCode?: string
): "session_error" | "sidecar_exited" {
  if (errorCode && AGENT_GONE.test(errorCode)) return "sidecar_exited"
  return AGENT_GONE.test(message) ? "sidecar_exited" : "session_error"
}

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
  home?: string
  manager?: ExternalAgentSessionManager
  transcriptFs?: TranscriptFs
  now?: () => number
  /**
   * An agent the backend controller already registered and connected at
   * startup. Reusing it is what keeps "connect before the composer opens" from
   * spawning a SECOND process on the first turn. Ownership follows creation:
   * the controller registered this agent, so the controller removes it — the
   * session only cancels its own in-flight turn on close.
   */
  connection?: { agentId: string; presetId: string }
  /**
   * The MCP servers to hand the agent's `session/new`. Defaults to the CLI's own
   * resolved set — `.mcp.json` from the cwd + home, minus the `/mcp` disable
   * overlay — which is the same source the built-in path uses, so a server the
   * user enabled reaches whichever agent is answering. Injected in tests.
   */
  resolveMcpServers?: () => McpServer[]
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
  const requestedRememberChoice = decision.decision === "allow_always"
  const wantedKinds =
    decision.decision !== "deny"
      ? requestedRememberChoice
        ? (["allow_always", "allow_once"] as const)
        : (["allow_once"] as const)
      : (["reject_once", "reject_always"] as const)
  const selectedOption = wantedKinds
    .map((kind) => request.options?.find((option) => option.kind === kind))
    .find((option) => option !== undefined)
  const optionsConstrainChoice = Boolean(request.options?.length)
  const granted =
    decision.decision !== "deny" &&
    (!optionsConstrainChoice || selectedOption?.kind.startsWith("allow") === true)
  const rememberChoice = selectedOption?.kind === "allow_always"
  return {
    requestId: request.requestId ?? request.id,
    granted,
    ...(decision.message ? { reason: decision.message } : {}),
    rememberChoice,
    scope: rememberChoice ? "always" : "once",
    ...(selectedOption ? { optionId: selectedOption.optionId } : {}),
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
  const agentId = params.connection?.agentId ?? `cli-external-${sessionId}`
  // The controller registered this agent, so it also removes it; a session that
  // registered its own is responsible for its own teardown.
  const ownsAgent = params.connection === undefined
  const home = params.home ?? resolveHome(process.env, os.homedir())
  // A desktop-lived health interval would keep a completed CLI process alive.
  // CLI sessions connect lazily per turn and remove their agent on close, so no
  // background poller is needed.
  const manager =
    params.manager ?? (getExternalAgentManager({ healthCheckInterval: 0 }) as ExternalAgentManager)
  const resolveMcpServers =
    params.resolveMcpServers ??
    (() => applyDisabled(loadMcpServers([params.config.cwd, home]), readDisabled(home)))
  // Re-resolved lazily so a `/mcp` toggle reaches the NEXT turn's `session/new`
  // without tearing the agent down; `invalidateOptions` drops the cache.
  let mcpServers: AcpMcpServerConfig[] | undefined
  let initialized = params.connection !== undefined
  let closed = false
  // Seeded from the recorded link so a `/resume` continues the agent's OWN
  // session instead of silently starting an empty one behind a full transcript.
  // Only a link from the SAME backend is usable — no agent can load another's.
  const recordedLink = readExternalLink(home, sessionId, params.transcriptFs)
  let externalSessionId = isResumableLink(recordedLink, backend)
    ? recordedLink.externalSessionId
    : undefined
  let permissionMode = normalizePermissionMode(params.config.permissionMode)

  const ensureAgent = async (): Promise<void> => {
    if (initialized) return
    const presetId = backend === "codex" ? await resolvePreferredCodexExecutablePresetId() : backend
    const config = createAgentFromPreset(presetId, {
      id: agentId,
      enabled: true,
      defaultPermissionMode: permissionMode,
      // Bounds `manager.connect` only — every `execute` passes its own budget.
      timeout: resolveConnectTimeoutMs(params.config),
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

      // Bound the turn by silence, not by wall clock. `watchdog` arms on the
      // first streamed event and pauses while a permission prompt is on screen,
      // so neither a slow cold start nor a long approval can trip it.
      const watchdog = createIdleWatchdog({ timeoutMs: resolveIdleTimeoutMs(params.config) })
      // The event stream carries the external session id before the result does;
      // capturing it here lets a mid-turn cancel target the right session on the
      // very first turn (when `externalSessionId` is still unset).
      let observedSessionId = externalSessionId
      let result: ExternalAgentResult
      try {
        const execution = manager.execute(agentId, prompt, {
          ...(externalSessionId ? { sessionId: externalSessionId } : {}),
          ...(params.config.model ? { model: params.config.model } : {}),
          ...(params.config.systemPrompt ? { systemPrompt: params.config.systemPrompt } : {}),
          permissionMode,
          ...(params.config.allowedTools ? { allowedTools: params.config.allowedTools } : {}),
          // The user's own MCP servers, projected into the ACP shape. This was
          // a hardcoded empty array, so a server enabled in `/mcp` silently did
          // nothing on an external backend while the panel showed it as on.
          context: {
            custom: {
              mcpServers: (mcpServers ??= toAcpMcpServers(resolveMcpServers())),
              additionalDirectories: params.config.additionalRoots ?? [],
            },
          },
          workingDirectory: params.config.cwd,
          ...(opts.signal ? { signal: opts.signal } : {}),
          // Always explicit: an omitted budget makes the manager fall back to the
          // agent config's `timeout`, which is the CONNECT budget and would cap
          // every turn at a minute.
          timeout:
            opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : EXTERNAL_TURN_WALL_CLOCK_MS,
          onPermissionRequest: async (request) => {
            watchdog.pause()
            try {
              const decision = await opts.gate(acpPermissionRequestToCli(request, sessionId))
              return captureDecisionToAcp(request, decision)
            } finally {
              watchdog.resume()
            }
          },
          onEvent: (event) => {
            watchdog.bump()
            if (event.sessionId) observedSessionId = event.sessionId
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
        // Fold rejection into the value so the losing race branch can never
        // surface as an unhandled rejection.
        const settled = execution.then(
          (value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "failed" as const, error })
        )
        const outcome = await Promise.race([
          settled,
          watchdog.whenIdle().then(() => ({ kind: "idle" as const })),
        ])

        if (outcome.kind === "idle") {
          // The stream went silent. Cancel the in-flight turn but KEEP the
          // session: the process is alive and its context is still intact, so
          // the next message continues the conversation.
          if (observedSessionId) {
            await manager.cancel(agentId, observedSessionId).catch(() => undefined)
          }
          throw new RunAndCaptureError(
            `External agent stream idle for ${resolveIdleTimeoutMs(params.config)}ms`,
            "session_error"
          )
        }
        if (outcome.kind === "failed") {
          const error = outcome.error
          if (error instanceof RunAndCaptureError) throw error
          const message = error instanceof Error ? error.message : String(error)
          throw new RunAndCaptureError(message, classifyExternalFailure(message))
        }
        result = outcome.value
      } finally {
        watchdog.stop()
      }

      if (result.sessionId && result.sessionId !== externalSessionId) {
        externalSessionId = result.sessionId
        // Record it as soon as the agent names it, so even a session that later
        // fails can be resumed rather than lost.
        writeExternalLink(
          home,
          sessionId,
          { backend, externalSessionId: result.sessionId },
          params.transcriptFs
        )
      }
      if (!result.success) {
        const message = result.error || "External agent execution failed"
        throw new RunAndCaptureError(message, classifyExternalFailure(message, result.errorCode))
      }
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
    invalidateOptions() {
      // Only the per-turn payload can be re-resolved in place. Connect-time
      // facts (reasoning effort, skill roots) ride the agent registration and
      // need a `/backend` reconnect — which is why the capability gate describes
      // them that way rather than pretending a toggle takes effect here.
      mcpServers = undefined
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
      if (ownsAgent) await manager.removeAgent(agentId)
    },
  }
}
