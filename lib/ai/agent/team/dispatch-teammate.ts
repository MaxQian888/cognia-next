/**
 * `dispatchTeammate` — the reusable teammate-dispatch primitive (ADR-0022
 * addendum). This is the ultracode `agent()` equivalent: claim a teammate from
 * the pool, run one turn (tool-enabled via the sidecar on desktop, text-only
 * fallback elsewhere), validate, record success/failure on the breaker + budget,
 * and fire the agent/teammate lifecycle hooks.
 *
 * Extracted from the `action.team.task.dispatch` node executor
 * (`lib/workflow/nodes/built-ins.ts`) so both that executor AND the higher-order
 * `pattern.*` nodes share one dispatch path. The pool's `claim()` is
 * non-exclusive round-robin, so pattern fan-out can reuse teammates across many
 * concurrent dispatches.
 *
 * Hook note: this executor is the SINGLE source of the `onTeammateClaim` /
 * `onTeammateRelease` plugin hooks (fired below, interleaved with the agent
 * lifecycle hooks + system-bus events). The pool no longer dispatches them —
 * doing so double-counted every claim/release for plugin consumers.
 */

import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { startSpan, endSpan } from "@cognia/agent-trace/emitter"
import { recordTeamUsage, swallowUsageWrite } from "@/lib/db/session-usage"
import type { SpanUsage } from "@/types/agent-trace/span"
import type { AgentTeammate, ResolvedCapabilities, AgentTeamConfig } from "@/types/agent/agent-team"
import type { ExternalSessionPermissionSpec } from "@/lib/ai/agent/external/permission-cascade"
import { resolveTeammateCapabilities } from "./capability-resolver"
import { teammateToCharacter } from "./teammate-character"
import { applyTeammateTwinContext } from "./twin-context"
import type { TeamRunContext } from "./team-run-context"
import type { WorktreeHandle } from "./workspace/allocator"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { createTeammateProgressReporter } from "./teammate-progress-coalescer"
import { agendaFingerprint, parseRateLimitCooldown } from "./nudge-guard"

const DEFAULT_TEAMMATE_SYSTEM_PROMPT =
  "You are a focused, helpful agent teammate. Stay on-task and produce concrete output."

const DEFAULT_PER_TASK_TIMEOUT_MS = 600_000

export type TeammateChannel = "sidecar" | "text" | "external"

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface DispatchTeammateArgs {
  /** Logical (sub-)task id used for pool.claim + store status writes. */
  taskId: string
  /**
   * The user prompt for the teammate turn. A function form receives the
   * claimed teammate so the caller can build a persona-aware prompt (the
   * legacy executor uses `buildTeammatePrompt(team, teammate, task)`).
   */
  prompt: string | ((teammate: AgentTeammate) => string)
  /** System prompt override; falls back to teammate/team default. */
  systemPrompt?: string
  /** Caller signal (run / pattern). Combined with a per-task timeout. */
  signal?: AbortSignal
  /** Per-task timeout (ms). Falls back to `team.config.defaultTimeout` or 600s. */
  timeoutMs?: number
  /** Force the text-only path even on desktop (used by pure-reasoning lenses). */
  preferToolEnabled?: boolean
  /** Minimum non-whitespace chars. Falls back to `team.config.minOutputChars`. */
  minOutputChars?: number
  /** Enforce empty/min-output validation (EMPTY_OUTPUT). Default true. */
  validateOutput?: boolean
  /** Mirror the result to the store (result_share message + task status). Default false. */
  recordToStore?: boolean
  /**
   * Skill-aware assignment hint forwarded to `pool.claim`. When this teammate
   * is available the pool claims it directly; otherwise it falls back to
   * round-robin. Set from a task's `assignedTo`.
   */
  preferTeammateId?: string
  /**
   * Under workspace isolation, groups dispatches that must share ONE git
   * worktree (pipeline handoff). Defaults to `taskId` → one worktree per
   * dispatch. Ignored when isolation is off.
   */
  workspaceKey?: string
}

export interface DispatchTeammateResult {
  text: string
  teammateId: string
  teammateName: string
  usage?: TokenUsage
  channel: TeammateChannel
}

function toSpanUsage(usage: TokenUsage): SpanUsage {
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}

/**
 * Build the team's permission ceiling — the parent spec every teammate dispatch
 * is clamped against. Returns `undefined` when the team expresses no ceiling
 * (no allow-list, deny-list, or mode), so callers skip the clamp entirely.
 */
function teamPermissionCeiling(
  config: AgentTeamConfig | undefined
): ExternalSessionPermissionSpec | undefined {
  if (!config) return undefined
  const spec: ExternalSessionPermissionSpec = {
    ...(config.allowedTools && config.allowedTools.length > 0
      ? { allowedTools: config.allowedTools }
      : {}),
    ...(config.disallowedTools && config.disallowedTools.length > 0
      ? { disallowedTools: config.disallowedTools }
      : {}),
    ...(config.defaultPermissionMode ? { permissionMode: config.defaultPermissionMode } : {}),
    ...(config.sandboxPolicy ? { sandboxPolicy: config.sandboxPolicy } : {}),
  }
  return Object.keys(spec).length > 0 ? spec : undefined
}

function readUsage(result: unknown): TokenUsage | undefined {
  const usage = (result as { usage?: TokenUsage } | null)?.usage
  if (
    usage &&
    typeof usage.promptTokens === "number" &&
    typeof usage.completionTokens === "number" &&
    typeof usage.totalTokens === "number"
  ) {
    return usage
  }
  return undefined
}

/** Run one teammate turn through the tool-enabled sidecar path. */
async function runToolEnabled(
  teamCtx: TeamRunContext,
  teammate: AgentTeammate,
  resolvedCaps: ResolvedCapabilities,
  prompt: string,
  systemPrompt: string,
  modelHint: string | undefined,
  signal: AbortSignal,
  onCaptureEvent?: (event: CaptureStreamEvent) => void,
  maxSteps?: number,
  cwdOverride?: string
): Promise<{ text: string; usage?: TokenUsage }> {
  const cwd = cwdOverride ?? teamCtx.team.config?.workingDir
  const character = teammateToCharacter({
    team: teamCtx.team,
    teammate,
    resolvedCaps,
    cwd,
    modelHint,
  })
  // The dispatch's resolved system prompt wins over the bridge's default.
  character.systemPrompt = systemPrompt

  const [sessionsDb, settingsDb, buildOpts, runner] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/db/settings"),
    import("@/lib/claude/build-options"),
    import("@/lib/claude/run-and-capture"),
  ])

  // A fresh session per dispatch — the sidecar tracks one in-flight query per
  // session id, so concurrent pattern fan-out needs distinct sessions.
  // `kind: "team"` makes resolveSendOptions union the team-context subagents.
  const session = await sessionsDb.createSession({
    title: `Ultracode — ${teammate.name}`,
    kind: "team",
    characterId: character.id,
    ...(cwd ? { workingDir: cwd } : {}),
  })
  // Team ceiling: the teammate character already carries its own `allowedTools`
  // (= teammate.config.tools); clamp that resolved surface against the team's
  // ceiling so a teammate can never widen beyond what the team permits.
  const ceiling = teamPermissionCeiling(teamCtx.team.config)
  // Bind this ephemeral session to the teammate's identity so host-routed
  // team-collaboration tools (team-builtin-tools.ts) know who is calling.
  const { registerTeamDispatchContext, clearTeamDispatchContext, clearResolvedPermissionCeiling } =
    await import("@/lib/claude/agents/dispatch-context-registry")
  registerTeamDispatchContext(session.id, {
    teamId: teamCtx.teamId,
    teammateId: teammate.id,
    teammateName: teammate.name,
    runId: teamCtx.runId,
  })
  try {
    const appSettings = await settingsDb.getSettings().catch(() => undefined)
    const sessionRow = (await sessionsDb.getSession(session.id)) ?? session
    const sendOptions = await buildOpts.resolveSendOptions({
      session: sessionRow,
      character,
      appSettings: appSettings ?? null,
      ...(ceiling ? { permissionCeiling: ceiling } : {}),
      // Twin-backed teammate (ADR-0003): feed the per-run vector-store deps +
      // the task prompt so resolveSendOptions' twin branch injects the twin's
      // persona + per-task RAG. Guard is satisfied only when the teammate is
      // twin-bound (`character.twinId`) AND the run built twin deps.
      ...(character.twinId && teamCtx.twinDeps
        ? {
            twinDeps: teamCtx.twinDeps,
            twinUserMessage: prompt,
            twinInjectSource: "team",
          }
        : {}),
    })
    // Apply the resolved step budget as an explicit per-dispatch turn cap. The
    // sidecar dispatcher honors `maxTurns` (an explicit value takes precedence
    // over its default 256-turn budget).
    if (typeof maxSteps === "number" && maxSteps > 0) sendOptions.maxTurns = maxSteps
    const result = await runner.runAndCaptureAssistantReply(session.id, prompt, sendOptions, {
      signal,
      ...(onCaptureEvent ? { onEvent: onCaptureEvent } : {}),
      execution: {
        kind: "team",
        label: `Team ${session.id.slice(0, 8)}`,
        ...(session.projectId ? { projectId: session.projectId } : {}),
      },
    })
    return { text: result.text ?? "", usage: readUsage(result) }
  } finally {
    clearResolvedPermissionCeiling(session.id)
    clearTeamDispatchContext(session.id)
    void sessionsDb.deleteSession(session.id).catch(() => undefined)
  }
}

/**
 * Run one teammate turn through an external CLI agent (Thread A1). The teammate
 * is backed by an external preset resolved upstream; we apply the permission
 * cascade (team → teammate) before handing the prompt to the manager, which
 * spawns/reuses the CLI process and streams back a final response.
 */
async function runExternalBacked(
  teamCtx: TeamRunContext,
  teammate: AgentTeammate,
  resolvedCaps: ResolvedCapabilities,
  agentId: string,
  prompt: string,
  systemPrompt: string,
  signal: AbortSignal,
  onCaptureEvent?: (event: CaptureStreamEvent) => void,
  cwdOverride?: string,
  model?: string
): Promise<{ text: string; usage?: TokenUsage }> {
  const [
    { getExternalAgentManager },
    { deriveExternalSessionPermission },
    { resolveAcpMcpServers },
    { pipeExternalEventsToCapture },
  ] = await Promise.all([
    import("@/lib/ai/agent/external/manager"),
    import("@/lib/ai/agent/external/permission-cascade"),
    import("@/lib/ai/agent/external/resolve-acp-mcp-servers"),
    import("@/lib/ai/agent/external/external-event-progress"),
  ])
  const manager = getExternalAgentManager()

  // Cascade: the team is the parent ceiling; the teammate may only further
  // restrict. The team's allow/deny/mode ceiling (when configured) flows in as
  // the parent so a teammate can never widen beyond it.
  const merged = deriveExternalSessionPermission(
    teamPermissionCeiling(teamCtx.team.config) ?? {},
    teammate.config?.tools ? { allowedTools: teammate.config.tools } : {}
  )

  // Forward the teammate's explicitly-resolved MCP servers into the external
  // agent's ACP session so it can call the same tools a built-in teammate would
  // (the external CLI keeps its own MCP config in addition to these).
  const mcpServers = await resolveAcpMcpServers(resolvedCaps.mcpServerIds)

  const result = await manager.execute(agentId, prompt, {
    systemPrompt,
    // The sidecar and text channels both honour the resolved model; the
    // external channel used to drop it on the floor, so an external teammate
    // silently ran on whatever its CLI's own config selected.
    ...(model ? { model } : {}),
    ...(merged.permissionMode ? { permissionMode: merged.permissionMode } : {}),
    ...(merged.allowedTools ? { allowedTools: merged.allowedTools } : {}),
    ...((cwdOverride ?? teamCtx.team.config?.workingDir)
      ? { workingDirectory: cwdOverride ?? teamCtx.team.config?.workingDir }
      : {}),
    ...(mcpServers.length > 0 ? { context: { custom: { mcpServers } } } : {}),
    // Live progress: translate the external protocol stream into the same
    // CaptureStreamEvent frames the sidecar channel emits, so an external
    // teammate streams tool-calls/text into the activity panel too.
    ...(onCaptureEvent ? { onEvent: pipeExternalEventsToCapture(onCaptureEvent) } : {}),
    signal,
  })

  if (!result.success) {
    throw new Error(result.error || `external agent ${agentId} returned a failure`)
  }

  return {
    text: result.finalResponse ?? "",
    usage: result.tokenUsage
      ? {
          promptTokens: result.tokenUsage.promptTokens,
          completionTokens: result.tokenUsage.completionTokens,
          totalTokens: result.tokenUsage.totalTokens,
        }
      : undefined,
  }
}

/** Run one teammate turn through the text-only AI-SDK fallback (web/mobile). */
async function runTextOnly(
  prompt: string,
  systemPrompt: string,
  modelHint: string | undefined,
  signal: AbortSignal,
  maxSteps?: number
): Promise<{ text: string; usage?: TokenUsage }> {
  const { executeAgent } = await import("../agent-executor")
  const result = await executeAgent(prompt, {
    systemPrompt,
    ...(modelHint ? { model: modelHint } : {}),
    ...(typeof maxSteps === "number" && maxSteps > 0 ? { maxSteps } : {}),
    abortSignal: signal,
  })
  return { text: result.text ?? "", usage: readUsage(result) }
}

/**
 * Claim a teammate and run one dispatch. Throws on no-available-teammate
 * (retryable by the workflow runStep) and on LLM/validation failure (after
 * recording the failure on the breaker).
 */
export async function dispatchTeammate(
  teamCtx: TeamRunContext,
  args: DispatchTeammateArgs
): Promise<DispatchTeammateResult> {
  const teammate = teamCtx.pool.claim(
    args.taskId,
    args.preferTeammateId ? { preferTeammateId: args.preferTeammateId } : undefined
  )
  if (!teammate) {
    // Retryable — workflow runStep backs off; the pool may free up.
    throw new Error("dispatchTeammate: no available teammate")
  }

  // Resolve + cache the teammate's plugin capability bundle once per run.
  if (!teamCtx.resolvedCapabilities.has(teammate.id)) {
    teamCtx.resolvedCapabilities.set(
      teammate.id,
      resolveTeammateCapabilities(teamCtx.team, teammate)
    )
  }
  const resolvedCaps = teamCtx.resolvedCapabilities.get(teammate.id)!

  const hooks = getPluginLifecycleHooks()
  hooks.dispatchOnTeammateClaim({
    teamId: teamCtx.teamId,
    runId: teamCtx.runId,
    teammateId: teammate.id,
    taskId: args.taskId,
  })
  hooks.dispatchOnAgentStart(teammate.id, {
    teamId: teamCtx.teamId,
    runId: teamCtx.runId,
    taskId: args.taskId,
    role: teammate.role,
    name: teammate.name,
  })
  // Plugin bus: a team agent run started (ids only — PII red-line).
  emitSystemBusEvent(SystemEvents.AGENT_STARTED, {
    agentId: teammate.id,
    teamId: teamCtx.teamId,
    runId: teamCtx.runId,
    taskId: args.taskId,
    role: teammate.role,
  })

  const release = (kind: "success" | "failure", error?: Error): void => {
    hooks.dispatchOnTeammateRelease({
      teamId: teamCtx.teamId,
      runId: teamCtx.runId,
      teammateId: teammate.id,
      taskId: args.taskId,
      result: kind,
      error: error?.message,
    })
    if (kind === "success") hooks.dispatchOnAgentComplete(teammate.id, undefined)
    else if (error) hooks.dispatchOnAgentError(teammate.id, error)
    // Plugin bus: team agent run settled (ids only). On error we publish the
    // bounded error CLASS (`error.name`), never `error.message` — the bus is
    // reachable by any `events:subscribe` plugin (PII red-line).
    const busPayload = { agentId: teammate.id, teamId: teamCtx.teamId, runId: teamCtx.runId }
    if (kind === "success") emitSystemBusEvent(SystemEvents.AGENT_COMPLETED, busPayload)
    else if (error)
      emitSystemBusEvent(SystemEvents.AGENT_ERROR, { ...busPayload, error: error.name })
  }

  const timeoutMs =
    args.timeoutMs ??
    (typeof teamCtx.team.config?.defaultTimeout === "number" &&
    teamCtx.team.config.defaultTimeout > 0
      ? teamCtx.team.config.defaultTimeout
      : DEFAULT_PER_TASK_TIMEOUT_MS)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combinedSignal = args.signal ? AbortSignal.any([args.signal, timeoutSignal]) : timeoutSignal

  const systemPrompt =
    args.systemPrompt?.trim() ||
    teammate.config?.systemPrompt?.trim() ||
    teamCtx.team.config?.defaultSystemPrompt?.trim() ||
    DEFAULT_TEAMMATE_SYSTEM_PROMPT

  const modelHint = teamCtx.modelPref.get().modelHint
  const promptText = typeof args.prompt === "function" ? args.prompt(teammate) : args.prompt

  // Resolved agentic step budget: a teammate's own `maxSteps` overrides the
  // team-level `defaultMaxSteps`. Undefined → the channel keeps its own default
  // (executeAgent's internal cap / the sidecar dispatcher's 256-turn budget).
  const positive = (v: unknown): number | undefined =>
    typeof v === "number" && v > 0 ? v : undefined
  const maxSteps =
    positive(teammate.config?.maxSteps) ?? positive(teamCtx.team.config?.defaultMaxSteps)

  const runtime = teammate.config?.runtime ?? "claude"
  let channel: TeammateChannel = "text"
  let externalAgentId: string | null = null
  if (runtime !== "claude" || resolvedCaps.externalAgentPresetIds.length > 0) {
    // External-backed teammate: route to the external CLI agent when a preset
    // resolves (desktop-only). On web/mobile or unknown preset this returns
    // null and we fall through to the built-in path below.
    const { resolveTeammateExternalAgent } = await import("./resolve-external-backing")
    externalAgentId = await resolveTeammateExternalAgent(teammate, resolvedCaps, teamCtx)
    if (externalAgentId) channel = "external"
  }
  if (channel !== "external" && args.preferToolEnabled !== false && runtime === "claude") {
    const { isTauri } = await import("@/lib/tauri")
    if (isTauri()) channel = "sidecar"
  }
  if (channel === "text" && runtime === "claude" && args.preferToolEnabled !== false) {
    // Reached only when a tool-capable `claude` teammate could not get the
    // desktop sidecar (isTauri() was false). On a desktop target this "should
    // never happen"; when it does the teammate silently loses tools + sub-agent
    // nesting, so surface it instead of degrading quietly. Excludes external,
    // intentional text (preferToolEnabled === false), and non-claude runtimes.
    teamCtx.notifier.notify({
      level: "warn",
      title: "Teammate degraded to text channel",
      body: `${teammate.name} is running without tools or sub-agent nesting — the desktop sidecar was unavailable.`,
      runId: teamCtx.runId,
      teamId: teamCtx.teamId,
      taskId: args.taskId,
      dedupeKey: `text-fallback:${teamCtx.runId}:${teammate.id}`,
    })
  }
  if (
    (runtime !== "claude" || resolvedCaps.externalAgentPresetIds.length > 0) &&
    channel !== "external"
  ) {
    // An external-CLI-backed teammate (e.g. runtime "codex"/"claude-code", or a
    // teammate carrying an external-agent preset) could not reach its external
    // agent — the browser/mobile shell has no external-agent host, or the CLI is
    // not installed. Rather than SILENTLY running the task on the built-in engine
    // (wrong model + wrong tools than the user asked for), surface the fallback.
    const wantedAgent =
      runtime !== "claude" ? runtime : (resolvedCaps.externalAgentPresetIds[0] ?? "external agent")
    teamCtx.notifier.notify({
      level: "warn",
      title: "External runtime unavailable",
      body: `${teammate.name} is configured to run on "${wantedAgent}", but that external agent is unavailable here — falling back to the built-in engine.`,
      runId: teamCtx.runId,
      teamId: teamCtx.teamId,
      taskId: args.taskId,
      dedupeKey: `external-fallback:${teamCtx.runId}:${teammate.id}`,
    })
  }

  // Live progress streaming → workspace activity panel. Built only when the
  // store exposes an `addEvent` sink (UI runs; eval/plan fixtures omit it).
  // `streamProgress !== false` (default ON) threads the sidecar capture stream
  // for live frames; when disabled, only the start/done/failed markers fire so
  // the panel still reflects completion without per-token churn.
  const progressSink = teamCtx.storeWriter.addEvent
  const streamFull = teamCtx.team.config?.streamProgress !== false
  const reporter = progressSink
    ? createTeammateProgressReporter(
        {
          teamId: teamCtx.teamId,
          teammateId: teammate.id,
          teammateName: teammate.name,
          taskId: args.taskId,
          channel,
        },
        (event) => progressSink(event)
      )
    : null
  reporter?.start()

  // Emit one `invoke_agent` span per dispatch so eval (and observability) can
  // assemble the run. The eval team target threads `teamCtx.traceId` so all
  // dispatch spans share one trace; normal runs fall back to a generated one.
  const span = startSpan({
    operationName: "invoke_agent",
    providerName: "cognia.team",
    surface: "agent-team",
    sessionId: teamCtx.runId,
    ...(teamCtx.traceId ? { traceId: teamCtx.traceId } : {}),
    agentId: teammate.id,
    agentName: teammate.name,
    ...(modelHint ? { requestModel: modelHint } : {}),
  })

  let turn: { text: string; usage?: TokenUsage }
  let workspace: WorktreeHandle | undefined
  const recordWorkspace = (ok: boolean, output?: string): void => {
    if (workspace && teamCtx.workspaceLedger) {
      teamCtx.workspaceLedger.set(workspace.key, {
        handle: workspace,
        ok,
        ...(output ? { output } : {}),
      })
    }
  }
  try {
    // Workspace isolation: give this dispatch its own git worktree + branch.
    // Fail-closed — an allocation error flows through the catch below (recorded
    // as a failure + released) instead of silently running in the shared dir.
    if (teamCtx.workspaceAllocator) {
      workspace = await teamCtx.workspaceAllocator.allocate({
        runId: teamCtx.runId,
        teammateName: teammate.name,
        taskId: args.taskId,
        ...(args.workspaceKey ? { workspaceKey: args.workspaceKey } : {}),
      })
    }
    if (channel === "external" && externalAgentId) {
      turn = await runExternalBacked(
        teamCtx,
        teammate,
        resolvedCaps,
        externalAgentId,
        promptText,
        systemPrompt,
        combinedSignal,
        streamFull && reporter ? (event) => reporter.onCaptureEvent(event) : undefined,
        workspace?.path,
        // The teammate's own model wins over the run-level hint, mirroring the
        // sidecar path (where teammateToCharacter applies config.model first).
        teammate.config?.model ?? modelHint
      )
    } else if (channel === "sidecar") {
      turn = await runToolEnabled(
        teamCtx,
        teammate,
        resolvedCaps,
        promptText,
        systemPrompt,
        modelHint,
        combinedSignal,
        // Real per-event streaming only on the sidecar path; external + text
        // channels surface start/terminal markers via the reporter instead.
        streamFull && reporter ? (event) => reporter.onCaptureEvent(event) : undefined,
        maxSteps,
        workspace?.path
      )
    } else {
      // Twin-backed teammate on the text-only channel (web/mobile): executeAgent
      // bypasses resolveSendOptions, so pre-inject the twin's persona + per-task
      // RAG into the system prompt here. Degrades to `systemPrompt` on failure.
      let textSystemPrompt = systemPrompt
      if (teammate.config?.twinId && teamCtx.twinDeps) {
        const injected = await applyTeammateTwinContext({
          actorName: teammate.name,
          baseSystemPrompt: systemPrompt,
          userPrompt: promptText,
          twinId: teammate.config.twinId,
          ...(teammate.config.twinSettings ? { twinSettings: teammate.config.twinSettings } : {}),
          twinDeps: teamCtx.twinDeps,
          source: "team",
        })
        textSystemPrompt = injected.systemPrompt
      }
      turn = await runTextOnly(promptText, textSystemPrompt, modelHint, combinedSignal, maxSteps)
    }
  } catch (err) {
    reporter?.finalize("failed")
    endSpan(span.spanId, {
      errorType: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    teamCtx.pool.recordFailure(teammate.id, err)
    if (args.recordToStore) {
      teamCtx.storeWriter.setTaskStatus(
        args.taskId,
        "failed",
        undefined,
        err instanceof Error ? err.message : String(err)
      )
    }
    const error = err instanceof Error ? err : new Error(String(err))
    // Rate-limit auto-resume: when the failure is a provider rate limit with a
    // known cooldown, schedule a single guarded "continue" nudge (additive — the
    // wave's existing error handling still runs). No-op when nudges are disabled
    // (controller absent) or the error isn't a rate limit.
    const cooldown = parseRateLimitCooldown(error.message)
    if (cooldown && teamCtx.rateLimitResume) {
      teamCtx.rateLimitResume.onRateLimit({
        memberId: teammate.id,
        fingerprint: agendaFingerprint([{ id: args.taskId, status: "failed" }]),
        retryAfterMs: cooldown.retryAfterMs,
      })
    }
    recordWorkspace(false)
    release("failure", error)
    throw error
  }

  endSpan(span.spanId, {
    ...(turn.usage ? { usage: toSpanUsage(turn.usage) } : {}),
    ...(modelHint ? { responseModel: modelHint } : {}),
    outputPreview: (turn.text ?? "").slice(0, 200),
  })

  const text = (turn.text ?? "").toString()
  const trimmed = text.trim()

  if (args.validateOutput !== false) {
    if (trimmed.length === 0) {
      const empty = new Error("EMPTY_OUTPUT: teammate returned empty response")
      reporter?.finalize("failed")
      teamCtx.pool.recordFailure(teammate.id, empty)
      if (args.recordToStore) {
        teamCtx.storeWriter.setTaskStatus(args.taskId, "failed", undefined, empty.message)
      }
      recordWorkspace(false)
      release("failure", empty)
      throw empty
    }
    const minChars = args.minOutputChars ?? teamCtx.team.config?.minOutputChars ?? 0
    if (minChars > 0 && trimmed.length < minChars) {
      const short = new Error(
        `EMPTY_OUTPUT: output below minOutputChars=${minChars} (got ${trimmed.length})`
      )
      reporter?.finalize("failed")
      teamCtx.pool.recordFailure(teammate.id, short)
      if (args.recordToStore) {
        teamCtx.storeWriter.setTaskStatus(args.taskId, "failed", undefined, short.message)
      }
      recordWorkspace(false)
      release("failure", short)
      throw short
    }
  }

  teamCtx.pool.recordSuccess(teammate.id)
  if (turn.usage) {
    teamCtx.budget.add(turn.usage)
    // Shadow-write into the unified billing table so standalone team runs
    // (which otherwise only emit agent-trace spans) count toward Usage-tab
    // spend. Fire-and-forget — never let the billing mirror fail the turn.
    swallowUsageWrite(
      recordTeamUsage({
        runId: teamCtx.runId,
        teammateId: teammate.id,
        taskId: args.taskId,
        usage: {
          inputTokens: turn.usage.promptTokens,
          outputTokens: turn.usage.completionTokens,
          ...(modelHint ? { model: modelHint } : {}),
        },
      })
    )
  }
  if (args.recordToStore) {
    teamCtx.storeWriter.addMessage({
      teamId: teamCtx.teamId,
      senderId: teammate.id,
      type: "result_share",
      content: text.length > 1200 ? `${text.slice(0, 1199)}…` : text,
      taskId: args.taskId,
    })
    // Acceptance gate (opt-in): route auto-success through the board's
    // human-owned `review` column instead of jumping straight to `completed`.
    // Board acceptance only — the wave runner's in-memory doneIds still
    // unblocks dependents, so this never stalls the run itself.
    const requireReview =
      teamCtx.team?.config?.governancePolicy?.approval?.requireResultReview === true
    teamCtx.storeWriter.setTaskStatus(args.taskId, requireReview ? "review" : "completed", text)
  }
  // Workspace isolation: capture the agent's work on its branch (worktrees are
  // GC'd; reconcile merge/select operate on commits). Best-effort — the turn
  // already succeeded, so a commit failure only warns.
  if (workspace && teamCtx.workspaceAllocator) {
    try {
      await teamCtx.workspaceAllocator.commit(workspace, `${teammate.name}: ${args.taskId}`)
    } catch {
      teamCtx.notifier.notify({
        level: "warn",
        title: "Worktree commit failed",
        body: `Could not commit ${teammate.name}'s worktree for task ${args.taskId}; its changes remain uncommitted.`,
        runId: teamCtx.runId,
        teamId: teamCtx.teamId,
        taskId: args.taskId,
        dedupeKey: `wt-commit:${teamCtx.runId}:${workspace.key}`,
      })
    }
  }
  recordWorkspace(true, text)
  reporter?.finalize("done")
  release("success")

  return {
    text,
    teammateId: teammate.id,
    teammateName: teammate.name,
    usage: turn.usage,
    channel,
  }
}
