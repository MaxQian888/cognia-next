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
 * Hook note: the pool ALSO dispatches `onTeammateClaim` / `onTeammateRelease`
 * (when constructed with teamId+runId). We preserve the original executor's
 * explicit dispatches here so observable behavior is unchanged — the redundancy
 * is pre-existing.
 */

import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { startSpan, endSpan } from "@/lib/agent-trace/emitter"
import { recordTeamUsage, swallowUsageWrite } from "@/lib/db/session-usage"
import type { SpanUsage } from "@/types/agent-trace/span"
import type { AgentTeammate, ResolvedCapabilities, AgentTeamConfig } from "@/types/agent/agent-team"
import type { ExternalSessionPermissionSpec } from "@/lib/ai/agent/external/permission-cascade"
import { resolveTeammateCapabilities } from "./capability-resolver"
import { teammateToCharacter } from "./teammate-character"
import type { TeamRunContext } from "./team-run-context"

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
  signal: AbortSignal
): Promise<{ text: string; usage?: TokenUsage }> {
  const cwd = teamCtx.team.config?.workingDir
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
    })
    const result = await runner.runAndCaptureAssistantReply(session.id, prompt, sendOptions, {
      signal,
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
  agentId: string,
  prompt: string,
  systemPrompt: string,
  signal: AbortSignal
): Promise<{ text: string; usage?: TokenUsage }> {
  const [{ getExternalAgentManager }, { deriveExternalSessionPermission }] = await Promise.all([
    import("@/lib/ai/agent/external/manager"),
    import("@/lib/ai/agent/external/permission-cascade"),
  ])
  const manager = getExternalAgentManager()

  // Cascade: the team is the parent ceiling; the teammate may only further
  // restrict. The team's allow/deny/mode ceiling (when configured) flows in as
  // the parent so a teammate can never widen beyond it.
  const merged = deriveExternalSessionPermission(
    teamPermissionCeiling(teamCtx.team.config) ?? {},
    teammate.config?.tools ? { allowedTools: teammate.config.tools } : {}
  )

  const result = await manager.execute(agentId, prompt, {
    systemPrompt,
    ...(merged.permissionMode ? { permissionMode: merged.permissionMode } : {}),
    ...(teamCtx.team.config?.workingDir
      ? { workingDirectory: teamCtx.team.config.workingDir }
      : {}),
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
  signal: AbortSignal
): Promise<{ text: string; usage?: TokenUsage }> {
  const { executeAgent } = await import("../agent-executor")
  const result = await executeAgent(prompt, {
    systemPrompt,
    ...(modelHint ? { model: modelHint } : {}),
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
  try {
    if (channel === "external" && externalAgentId) {
      turn = await runExternalBacked(
        teamCtx,
        teammate,
        externalAgentId,
        promptText,
        systemPrompt,
        combinedSignal
      )
    } else if (channel === "sidecar") {
      turn = await runToolEnabled(
        teamCtx,
        teammate,
        resolvedCaps,
        promptText,
        systemPrompt,
        modelHint,
        combinedSignal
      )
    } else {
      turn = await runTextOnly(promptText, systemPrompt, modelHint, combinedSignal)
    }
  } catch (err) {
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
      teamCtx.pool.recordFailure(teammate.id, empty)
      if (args.recordToStore) {
        teamCtx.storeWriter.setTaskStatus(args.taskId, "failed", undefined, empty.message)
      }
      release("failure", empty)
      throw empty
    }
    const minChars = args.minOutputChars ?? teamCtx.team.config?.minOutputChars ?? 0
    if (minChars > 0 && trimmed.length < minChars) {
      const short = new Error(
        `EMPTY_OUTPUT: output below minOutputChars=${minChars} (got ${trimmed.length})`
      )
      teamCtx.pool.recordFailure(teammate.id, short)
      if (args.recordToStore) {
        teamCtx.storeWriter.setTaskStatus(args.taskId, "failed", undefined, short.message)
      }
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
    teamCtx.storeWriter.setTaskStatus(args.taskId, "completed", text)
  }
  release("success")

  return {
    text,
    teammateId: teammate.id,
    teammateName: teammate.name,
    usage: turn.usage,
    channel,
  }
}
