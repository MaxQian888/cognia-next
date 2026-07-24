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
import { applyDisabled, readDisabled, readDisabledTools } from "../mcp/mcp-state"
import { toAcpMcpServers } from "../tui/runtime/backend-bridge"
import type { ResolvedConfig } from "../config/schema"
import { externalAgentEventToActions } from "../runtime/external/external-event-mapper"
import type { TuiAction } from "../tui/state/types"
import { createIdleWatchdog } from "./idle-watchdog"
import { isResumableLink, readExternalLink, writeExternalLink } from "./external-session-link"
import { mintSessionId } from "./run"
import type { AgentSession, SendTurnOptions } from "./session-runner"
import { appendTranscript, type TranscriptFs } from "./transcript"
import {
  createCliContextAssembler,
  prependTextBlock,
  twinContextBlock,
  type CliContextAssembler,
  type ResolvedCliSessionContext,
} from "./session-context"
import { registerTurnSubagentContext } from "./turn-dispatch"
import { readToolApprovals } from "./tool-approvals"
import { startToolHostBroker, type ToolHostBroker } from "./tool-host/broker"
import { createHostToolExecutor } from "./tool-host/host-tools"
import { buildToolHostMcpServers, isCogniaProjectedTool } from "./tool-host/spawn"
import {
  clearToolHostStatus,
  publishToolHostStatus,
  type ToolHostSnapshot,
} from "./tool-host/status"
import { visibleBuiltinTools, visibleHostTools } from "./tool-host/policy"
import { canHostCogniaTools } from "../tui/runtime/backend-capabilities"
import { CONTEXT_RESTART_NOTICE } from "../tui/runtime/context-lifecycle"
import {
  externalPromptText,
  unsupportedAttachmentMessage,
  type ExternalPromptResult,
} from "./external-prompt"
import { buildAttachmentContent } from "./attachments/build"
import { clearCliSubagentContext } from "./subagent-dispatch"
import type { PermissionResponder } from "./permission-gate"

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
  /** Switch the model of a LIVE session in place, so a `/model` pick does not
   * have to discard the thread. Throws when the adapter has no model selection;
   * the caller treats that as "applies on the next turn" rather than an error. */
  setSessionModel(agentId: string, sessionId: string, modelId: string): Promise<void>
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
  connection?: {
    agentId: string
    presetId: string
    /** What the agent advertised at `initialize`, so parity reporting can say
     * whether the protocol can carry Cognia's bridge at all. */
    capabilities?: {
      features?: unknown
      negotiated?: import("@/types/agent/external-agent").AcpCapabilities
    }
  }
  /**
   * The MCP servers to hand the agent's `session/new`. Defaults to the CLI's own
   * resolved set — `.mcp.json` from the cwd + home, minus the `/mcp` disable
   * overlay — which is the same source the built-in path uses, so a server the
   * user enabled reaches whichever agent is answering. Injected in tests.
   */
  resolveMcpServers?: () => McpServer[]
  /**
   * The shared Cognia context assembler. Defaults to one built from `config`,
   * which is what makes an external turn mean the same thing as a built-in one.
   * Injected in tests.
   */
  assembler?: CliContextAssembler
  /**
   * Start the Cognia tool host for a resolved session. Defaults to
   * {@link startToolHostBroker}; injected in tests (and set to a failing stub to
   * exercise the "backend cannot host Cognia tools" path).
   */
  startToolHost?: (params: {
    session: ResolvedCliSessionContext
    attempt: number
    gate?: PermissionResponder
    execHostTool: (name: string, args: unknown) => Promise<{ result?: unknown; error?: string }>
    onToolCall?: (event: { name: string; input: unknown; callKey: string }) => void
    onToolResult?: (event: { callKey: string; name: string; ok: boolean; summary?: string }) => void
  }) => Promise<ToolHostBroker>
  /** Project a live broker into `session/new` MCP entries. Injected in tests. */
  buildToolHostServers?: (broker: ToolHostBroker) => AcpMcpServerConfig[]
  /**
   * Disable the Cognia tool host entirely.
   *
   * The default parity contract REQUIRES it: an external session with no Cognia
   * tools is a different product, not a smaller one. This exists for the
   * explicitly-labelled raw mode and for tests.
   */
  disableToolHost?: boolean
  /** Resolve the per-tool MCP disable overlay for the turn dispatch context. */
  resolveDisabledMcpTools?: () => Set<string>
  /** Resolve the user's persisted "Allow always" tool names. */
  resolveApprovedTools?: () => Set<string>
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

/**
 * Create a persistent external-agent session with the same interface — and the
 * same Cognia meaning — as the built-in sidecar.
 *
 * The session resolves its context through the SHARED assembler, so project
 * instructions, output style, agent mode, skills, tool policy, attachments and
 * twin grounding are identical to the built-in backend; only the transport
 * differs. Cognia's own tools ride an authenticated MCP bridge attached beside
 * the user's MCP servers, with Cognia — not the agent — deciding what may run.
 */
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
  const resolveApprovedTools = params.resolveApprovedTools ?? (() => readToolApprovals(home))
  const resolveDisabledMcpTools = params.resolveDisabledMcpTools ?? (() => readDisabledTools(home))
  const startToolHost = params.startToolHost ?? startToolHostBroker
  const buildToolHostServers =
    params.buildToolHostServers ??
    ((broker: ToolHostBroker) =>
      buildToolHostMcpServers({ endpoint: broker.endpoint, token: broker.token }))
  const toolHostEnabled = params.disableToolHost !== true
  const negotiated = params.connection?.capabilities?.negotiated

  // The ONE Cognia resolver. Attachments are built with vision OFF because the
  // external transport carries a single text prompt: images and PDFs then take
  // Cognia's established OCR / text-extraction fallback instead of becoming
  // blocks the wire cannot represent.
  const assembler =
    params.assembler ??
    createCliContextAssembler({
      config: params.config,
      sessionId,
      home,
      now,
      resolveMcpServers,
      resolveApprovedTools,
      resolveDisabledMcpTools,
      buildContent: (prompt, cwd) =>
        buildAttachmentContent(prompt, cwd, {
          provider: params.config.provider ?? "external",
          model: "",
          isAnthropic: false,
          anthropicKey: () =>
            params.config.providers["anthropic"]?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null,
        }),
    })

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
  // The tool host for the CURRENT protocol session. Torn down and rebuilt when
  // the context version changes, so a bridge can never outlive the context it
  // was minted for.
  let broker: ToolHostBroker | null = null
  let brokerAttempt = 0
  let skillsAnnounced = false
  let databaseErrorShown = false
  // Context version the live external protocol session was created under. A
  // mismatch means the agent is running with instructions Cognia no longer
  // considers current, so the session is recreated rather than continued.
  let sessionContextVersion: string | null = isResumableLink(recordedLink, backend)
    ? (recordedLink.contextVersion ?? null)
    : null

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

  /** Tear down the current tool host, if any. Safe to call repeatedly. */
  const stopToolHost = async (): Promise<void> => {
    if (!broker) return
    const current = broker
    broker = null
    // Reject anything still in flight BEFORE closing, so a bridge waiting on an
    // authorize gets a refusal rather than a dropped socket.
    current.cancelInFlight("the Cognia session context changed")
    await current.close().catch(() => undefined)
  }

  /**
   * (Re)start the tool host for `session` and return the MCP entries to attach.
   *
   * Under the default parity contract a tool host that cannot start is fatal:
   * an external session silently running without Cognia's tools is exactly the
   * "ready with fewer tools" lie this work removes.
   */
  const ensureToolHost = async (
    session: ResolvedCliSessionContext,
    opts: SendTurnOptions
  ): Promise<AcpMcpServerConfig[]> => {
    if (!toolHostEnabled) {
      publish(session, false)
      return []
    }
    if (broker && !broker.isClosed()) return buildToolHostServers(broker)
    brokerAttempt += 1
    const execHostTool = createHostToolExecutor({ sessionId })
    try {
      broker = await startToolHost({
        session,
        attempt: brokerAttempt,
        gate: opts.gate,
        execHostTool,
        onToolCall: (event) =>
          opts.onAction?.({
            type: "TOOL_CALL",
            callKey: event.callKey,
            toolName: event.name,
            input: (event.input ?? {}) as Record<string, unknown>,
          }),
        onToolResult: (event) =>
          opts.onAction?.({
            type: "TOOL_RESULT",
            callKey: event.callKey,
            toolName: event.name,
            result: event.summary ?? "",
            ...(event.ok ? {} : { isError: true }),
          }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new RunAndCaptureError(
        `Cognia could not host its tools for ${backend}: ${message}`,
        "session_error"
      )
    }
    publish(session, true)
    return buildToolHostServers(broker)
  }

  /** Publish what /status and /doctor should report about Cognia parity. */
  const publish = (session: ResolvedCliSessionContext, running: boolean): void => {
    const hostTools = visibleHostTools(session.sendOptions)
    const snapshot: ToolHostSnapshot = {
      backend,
      contextVersion: session.contextVersion,
      attachable: toolHostEnabled && canHostCogniaTools(negotiated),
      running: toolHostEnabled && running,
      builtinToolCount: visibleBuiltinTools(session.sendOptions).length,
      hostToolCount: hostTools.length,
      subagentDispatch: hostTools.includes("dispatch_agent"),
      userMcpCount: session.mcpServers.filter((server) => server.enabled !== false).length,
      connections: broker?.connections() ?? 0,
    }
    publishToolHostStatus(sessionId, snapshot)
  }

  /**
   * Resolve the session context and reconcile the live protocol session with it.
   *
   * Returns the context plus whether the external conversation had to be
   * restarted, so the caller can tell the user rather than let the agent lose
   * its history silently.
   */
  const reconcile = async (): Promise<{
    session: ResolvedCliSessionContext
    restarted: boolean
  }> => {
    const session = await assembler.resolveSession()
    let restarted = false
    // Only a session that actually exists can be stale. `sessionContextVersion`
    // is null for a link recorded before versions existed, and null never equals
    // a hash — so an unknown-context resume is refused exactly like a changed
    // one rather than silently continuing.
    if (externalSessionId && sessionContextVersion !== session.contextVersion) {
      // Everything `session/new` baked in has changed. Appending a second system
      // prompt to the live session would leave the agent with two conflicting
      // instruction sets and make resume non-deterministic, so start a new
      // protocol session instead — the TUI transcript is unaffected.
      await manager.cancel(agentId, externalSessionId).catch(() => undefined)
      externalSessionId = undefined
      await stopToolHost()
      mcpServers = undefined
      restarted = true
    }
    sessionContextVersion = session.contextVersion
    return { session, restarted }
  }

  return {
    sessionId,
    async send(prompt: string, opts: SendTurnOptions) {
      if (closed) throw new Error("agent session is closed")
      await ensureAgent()
      const { session, restarted } = await reconcile()
      if (restarted) {
        opts.onAction?.({ type: "NOTICE", message: CONTEXT_RESTART_NOTICE })
      }
      if (!skillsAnnounced && session.activeSkillIds.length > 0) {
        skillsAnnounced = true
        opts.onActiveSkills?.(session.activeSkillIds)
      }
      if (session.databaseError && !databaseErrorShown) {
        databaseErrorShown = true
        opts.onDatabaseError?.(session.databaseError)
      }
      const turn = await assembler.resolveTurn(prompt, session)
      if (turn.twinNotice) opts.onTwinNotice?.(turn.twinNotice)
      if (turn.attachments) opts.onAttachments?.(turn.attachments)

      // `session/new` already happened with the base prompt, so the twin persona
      // rides this turn's content (once) alongside the per-turn recall.
      let content = turn.content
      if (turn.dynamicTwinContext) {
        content = prependTextBlock(content, twinContextBlock(turn.dynamicTwinContext))
      }
      if (turn.stableTwinContext) {
        content = prependTextBlock(content, twinContextBlock(turn.stableTwinContext))
      }
      const flattened: ExternalPromptResult = externalPromptText(content)
      if (flattened.unsupported.length > 0) {
        // Fail BEFORE sending: dropping the attachment and answering anyway
        // would look like the agent read something it never received.
        throw new RunAndCaptureError(
          unsupportedAttachmentMessage(backend, flattened.unsupported),
          "session_error"
        )
      }
      const cogniaServers = await ensureToolHost(session, opts)

      appendTranscript(
        home,
        sessionId,
        { role: "user", content: prompt },
        params.transcriptFs,
        now()
      )
      // Publish this turn's dispatch context so a `dispatch_agent` call arriving
      // over the tool-host bridge runs with THIS turn's gate and signal.
      const clearDispatch = registerTurnSubagentContext({
        session,
        config: params.config,
        home,
        gate: opts.gate,
        ...(opts.signal ? { signal: opts.signal } : {}),
        approvedTools: resolveApprovedTools(),
        disabledMcpTools: resolveDisabledMcpTools(),
      })

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
        const execution = manager.execute(agentId, flattened.text, {
          ...(externalSessionId ? { sessionId: externalSessionId } : {}),
          // The model stays `config.model` — the contract there is "the model the
          // user explicitly asked this BACKEND for", an agent-owned id. The
          // resolved `sendOptions.model` is Cognia's provider catalog talking, and
          // substituting it would silently rewrite which model Codex/Claude Code
          // actually runs.
          ...(params.config.model ? { model: params.config.model } : {}),
          // The CANONICAL prompt, not `config.systemPrompt` — this is what makes
          // project instructions, output style, the active mode and the skill
          // catalog reach an external agent at all.
          ...(session.sendOptions.systemPrompt
            ? { systemPrompt: session.sendOptions.systemPrompt }
            : {}),
          permissionMode,
          // The agent's OWN tool pre-approval list, so it stays in the agent's
          // native tool vocabulary. Cognia's resolved tool policy is expressed in
          // `mcp__cognia-*__` names the agent cannot act on; it governs Cognia's
          // projected tools at the broker instead.
          ...(params.config.allowedTools?.length
            ? { allowedTools: params.config.allowedTools }
            : {}),
          instructionEnvelope: {
            hash: session.contextVersion,
            developerInstructions: session.sendOptions.systemPrompt ?? "",
            sourceFlags: {
              hasSkills: session.activeSkillIds.length > 0,
              hasCogniaTools: cogniaServers.length > 0,
              hasAdditionalRoots: session.additionalDirectories.length > 0,
            },
          },
          context: {
            custom: {
              // Cognia's own tools first, then the user's — both additive, and
              // both namespaced, so the agent's native tools stay untouched.
              mcpServers: [
                ...cogniaServers,
                ...(mcpServers ??= toAcpMcpServers(session.mcpServers)),
              ],
              additionalDirectories: session.additionalDirectories,
            },
          },
          workingDirectory: session.cwd,
          ...(opts.signal ? { signal: opts.signal } : {}),
          // Always explicit: an omitted budget makes the manager fall back to the
          // agent config's `timeout`, which is the CONNECT budget and would cap
          // every turn at a minute.
          timeout:
            opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : EXTERNAL_TURN_WALL_CLOCK_MS,
          onPermissionRequest: async (request) => {
            // A Cognia-projected tool is gated by the broker, which shows the
            // real prompt and owns the persisted rules. Acknowledging the
            // agent's generic ask here is what keeps ONE Cognia call from
            // producing TWO user prompts. Native agent tools fall through to
            // Cognia's overlay as before.
            if (isCogniaProjectedTool(request.toolInfo?.name)) {
              return captureDecisionToAcp(request, { decision: "allow" })
            }
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
          broker?.cancelInFlight("the turn was interrupted")
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
        clearDispatch()
      }

      if (result.sessionId && result.sessionId !== externalSessionId) {
        externalSessionId = result.sessionId
        // Record it as soon as the agent names it, so even a session that later
        // fails can be resumed rather than lost. The context version rides along
        // so a later `/resume` refuses a session created under other settings.
        writeExternalLink(
          home,
          sessionId,
          {
            backend,
            externalSessionId: result.sessionId,
            contextVersion: session.contextVersion,
          },
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
      // Re-resolve the whole Cognia context. Whether that merely changes the
      // next turn's payload or forces a protocol-session restart is decided by
      // the context version in `reconcile`, so `/mcp`, `/mode`, `/skill` and a
      // system-prompt edit all land in the right layer without special cases.
      assembler.invalidate()
      mcpServers = undefined
      skillsAnnounced = false
    },
    async setPermissionMode(mode) {
      permissionMode = normalizePermissionMode(mode)
      if (initialized && externalSessionId) {
        await manager.setSessionMode(agentId, externalSessionId, permissionMode)
      }
    },
    /**
     * Apply a `/model` pick to the live session so the thread survives it.
     *
     * Returns whether the switch actually landed on a live session. `false` is
     * the ordinary case before the first turn (no session exists yet) or when
     * the adapter has no model selection; in both, the new model still takes
     * effect on the next turn. Never throws: a rejected model must not take the
     * turn (or the TUI) down.
     */
    async setModel(model) {
      if (!initialized || !externalSessionId) return false
      try {
        await manager.setSessionModel(agentId, externalSessionId, model)
        return true
      } catch {
        return false
      }
    },
    isLive() {
      return initialized && !closed
    },
    async close() {
      if (closed) return
      closed = true
      // Shutdown order: stop accepting tool calls → reject pending broker calls
      // → cancel the external turn → close the protocol session → drop the
      // bridge → remove the agent. Doing it in any other order can leave a
      // bridge executing against a session that is already gone.
      clearCliSubagentContext(sessionId)
      clearToolHostStatus(sessionId)
      await stopToolHost()
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
