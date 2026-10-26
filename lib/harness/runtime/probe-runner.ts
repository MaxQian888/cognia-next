/**
 * Run one rollout: a harness snapshot on the run's task, isolated (ADR-0237).
 *
 * The rollout is an ordinary headless turn of the agent through the shared
 * path every other headless leg uses (`resolveSendOptions` →
 * `runAndCaptureAssistantReply`), so what is measured is what the agent would
 * do if the harness were adopted. What differs from a real turn:
 *
 * - the harness comes from the snapshot through the overlay, never from the
 *   agent row or the skill library ({@link materializeHarnessRun});
 * - the conversation is embedded (no list, search or sync), learns nothing
 *   into memory, and is deleted when the rollout ends;
 * - the working directory is the rollout's own ({@link prepareRolloutWorkspace});
 * - the probe grant and the permission responder decide every side effect
 *   (`./probe-policy.ts`), and the harness's own tool rules run on top;
 * - the turn's usage is claimed and booked once, under the
 *   `harness-evolution` surface and the run's id.
 */

import type {
  AppSettings,
  Character,
  ChatSession,
  PermissionRequestEvent,
  SendContent,
  SendOptions,
} from "@cognia/agent-config-types"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type {
  CapturePermissionDecision,
  CaptureStreamEvent,
  CaptureToolResult,
  CaptureToolResultDecision,
  RunAndCaptureOptions,
  RunAndCaptureResult,
} from "@/lib/claude/run-and-capture"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { SurfaceUsageInput } from "@/lib/db/session-usage"
import type {
  HarnessBlockedAction,
  HarnessEvolutionRun,
  HarnessExecutionEvidence,
} from "@/types/harness/evolution"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { buildExecutionEvidence } from "../evidence"
import { materializeHarnessRun } from "../overlay"
import {
  createToolRuleState,
  evaluatePreToolUse,
  hasResultRules,
  projectToolResult,
} from "../tool-rules"
import { createTrajectoryRecorder } from "../trajectory"
import { prepareRolloutWorkspace, type IsolationDeps, type RolloutWorkspace } from "./isolation"
import { excludeSessionFromLiveToolRules } from "./live-rules"
import { decideProbeToolCall, probeCapabilityGrant, type ProbePolicyContext } from "./probe-policy"

/** Usage-ledger surface every rollout books under. */
export const PROBE_USAGE_SURFACE = "harness-evolution" as const

/** The run-level facts a probe needs about the agent's tool surface, discovered once per run. */
export interface ProbeToolSurface {
  /** Plugin tools in the agent's resolved manifest that probes must not have. */
  pluginToolDenials: string[]
  /** Names of the declared-safe MCP servers as they appear in tool names. */
  allowedMcpServerNames: string[]
}

export interface ProbeUsageBooking {
  costUsd?: number
  /** `false` when no price was known for the model. */
  costKnown: boolean
}

export interface ProbeRunnerDeps {
  isolation: IsolationDeps
  createSession(partial: Partial<ChatSession>): Promise<ChatSession>
  deleteSession(id: string): Promise<void>
  getSettings(): Promise<AppSettings | null>
  resolveSendOptions(ctx: BuildOptionsContext): Promise<SendOptions>
  runTurn(
    sessionId: string,
    prompt: SendContent,
    options: SendOptions,
    cap: RunAndCaptureOptions
  ): Promise<RunAndCaptureResult>
  claimTurnUsage(sessionId: string, turnId: string): void
  /** Book one rollout's usage; returns the priced row's cost. */
  bookUsage(input: {
    operationId: string
    sessionId: string
    usage: SurfaceUsageInput
  }): Promise<ProbeUsageBooking | null>
  surfaceUsageFromUsageInfo(usage: UsageInfo, opts: { costAuthority?: boolean }): SurfaceUsageInput
  homeDir(): Promise<string | undefined>
  /** Trace id of the session's spans, when tracing captured any. */
  fetchTraceId?(sessionId: string): Promise<string | undefined>
  now(): number
  newId(): string
}

export interface ProbeInput {
  run: Pick<HarnessEvolutionRun, "id" | "task" | "config" | "projectId">
  label: string
  /** Attempt counter of the step; a re-run is new spend and books a new row. */
  attempt: number
  snapshot: Pick<HarnessSnapshotV1, "id" | "components">
  /** The agent's effective profile at capture; its execution config is kept. */
  baseCharacter: Character
  /** Skill ids outside the editable harness, loaded as the agent loads them. */
  carriedSkillIds: readonly string[]
  environmentFingerprint: string
  surface: ProbeToolSurface
  /** Per-rollout dollar ceiling where the runtime enforces one. */
  maxBudgetUsd?: number
  timeoutMs: number
  signal: AbortSignal
}

export interface ProbeUsage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
  /** True when the cost could not be priced; the ledger treats it as a lower bound. */
  costUnknown: boolean
}

export interface ProbeOutcome {
  evidence: HarnessExecutionEvidence
  usage: ProbeUsage
}

const RESULT_RULES_UNENFORCED_CAVEAT =
  "This runtime reports tool results after the model has seen them, so the harness's result rules (trim, hints, reminders, withheld over-cap results) were recorded but not applied."
const BUDGET_ADVISORY_CAVEAT =
  "This runtime cannot stop a turn at a dollar ceiling; the rollout was bounded by its turn limit and the run's budget is enforced between steps."
const SHELL_UNCONTAINED_CAVEAT =
  "Shell commands ran on this machine with the rollout's directory as their working directory; the probe policy refused recognisable outside effects, but programs were not contained by a sandbox."

function isShellTool(toolName: string): boolean {
  return /(^|__)(bash|Bash)$/.test(toolName)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Build the run's permission responder: the harness's call caps, then the probe policy. */
export function createProbePermissionResponder(input: {
  rules: Parameters<typeof evaluatePreToolUse>[0]
  state: ReturnType<typeof createToolRuleState>
  policy: ProbePolicyContext
  onBlocked(action: HarnessBlockedAction, toolInput: unknown): void
}): (request: PermissionRequestEvent) => CapturePermissionDecision {
  return (request) => {
    const cap = evaluatePreToolUse(input.rules, input.state, request.toolName)
    if (cap.action === "deny") {
      input.onBlocked({ toolName: request.toolName, reason: cap.reason }, request.input)
      return { decision: "deny", message: cap.reason, attribution: { authority: "policy-deny" } }
    }
    const verdict = decideProbeToolCall(request.toolName, request.input, input.policy)
    if (!verdict.allow) {
      const message = `${verdict.reason} This is a harness probe; finish without it and say what it would have done.`
      input.onBlocked({ toolName: request.toolName, reason: verdict.reason }, request.input)
      return { decision: "deny", message, attribution: { authority: "policy-deny" } }
    }
    return { decision: "allow", attribution: { authority: "policy-rule" } }
  }
}

/** Run one rollout and return its evidence. Never leaves the session or the workspace behind. */
export async function runProbe(input: ProbeInput, deps: ProbeRunnerDeps): Promise<ProbeOutcome> {
  const { run, label, snapshot } = input
  const task = run.task
  const startedAt = deps.now()
  input.signal.throwIfAborted()

  const session = await deps.createSession({
    title: `Harness probe ${label}`,
    characterId: input.baseCharacter.id,
    memoryLearn: false,
    visibility: "embedded",
    ...(run.projectId ? { projectId: run.projectId } : {}),
  })
  // The candidate's rules apply below; the stored agent's live rules must not stack on them.
  const includeInLiveRules = excludeSessionFromLiveToolRules(session.id)
  let workspace: RolloutWorkspace | undefined
  let finalState: "ready" | "failed" | "cancelled" = "failed"
  const recorder = createTrajectoryRecorder()
  const blockedActions: HarnessBlockedAction[] = []
  const caveats = new Set<string>()
  let usageInfo: UsageInfo | undefined
  let usage: ProbeUsage = { inputTokens: 0, outputTokens: 0, costUnknown: true }
  let usageBooked = false

  try {
    workspace = await prepareRolloutWorkspace(
      task,
      { runId: run.id, label, sessionId: session.id, characterId: input.baseCharacter.id },
      deps.isolation
    )
    input.signal.throwIfAborted()
    const materialized = materializeHarnessRun(
      snapshot,
      input.baseCharacter,
      deps.now(),
      input.carriedSkillIds
    )
    const sessionRow: ChatSession = {
      ...session,
      ...(workspace.root ? { workingDir: workspace.root, workspaceConfinementEnabled: true } : {}),
    }
    const grant = probeCapabilityGrant({
      runId: run.id,
      label,
      isolation: task.isolation,
      policy: run.config.probe,
      maxTurns: run.config.budget.maxTurnsPerRollout,
      ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
      pluginToolDenials: input.surface.pluginToolDenials,
      ...(run.config.models.executor ? { executor: run.config.models.executor } : {}),
    })
    const turnId = deps.newId()
    const resolved = await deps.resolveSendOptions({
      session: sessionRow,
      character: materialized.character,
      appSettings: await deps.getSettings(),
      activeProject: workspace.project ?? null,
      agentKind: "system",
      routingSurface: "agent",
      routingContextHint: { promptText: task.prompt },
      capabilityGrants: [grant],
      harnessOverlay: materialized.overlay,
      skillRenderMode: "hybrid",
      turnId,
    })
    input.signal.throwIfAborted()
    const rules = snapshot.components.toolRules
    const sdkLane = resolved.execution?.runtimeAdapter === "claude-agent-sdk"
    const options: SendOptions = {
      ...resolved,
      turnId: resolved.turnId ?? turnId,
      // The PostToolUse round-trip is what lets the result rules rewrite output.
      ...(hasResultRules(rules) ? { toolResultReviewEnabled: true } : {}),
    }
    if (hasResultRules(rules) && sdkLane) caveats.add(RESULT_RULES_UNENFORCED_CAVEAT)
    if (input.maxBudgetUsd !== undefined && !sdkLane) caveats.add(BUDGET_ADVISORY_CAVEAT)

    const ruleState = createToolRuleState()
    const policy: ProbePolicyContext = {
      isolation: task.isolation,
      ...(workspace.root ? { root: workspace.root } : {}),
      ...(await deps.homeDir().then((home) => (home ? { home } : {}))),
      networkOff: run.config.probe.networkOff,
      allowedMcpServerNames: new Set(input.surface.allowedMcpServerNames),
    }
    let usedShell = false
    const respond = createProbePermissionResponder({
      rules,
      state: ruleState,
      policy,
      onBlocked(action, toolInput) {
        blockedActions.push(action)
        recorder.recordBlocked(action.toolName, toolInput, action.reason)
      },
    })
    const onPermissionRequest = (request: PermissionRequestEvent) => {
      const decision = respond(request)
      if (decision.decision === "allow" && isShellTool(request.toolName)) usedShell = true
      return decision
    }
    const onToolResultReview = (
      request: CaptureToolResult
    ): CaptureToolResultDecision | undefined => {
      const projection = projectToolResult(
        rules,
        ruleState,
        request.toolName,
        request.result,
        request.isError
      )
      return projection.changed ? { updatedToolOutput: projection.output } : undefined
    }
    const onEvent = (event: CaptureStreamEvent) => {
      if (event.type === "usage" && !event.partial) usageInfo = event.usage
      if (event.type === "tool-call" && isShellTool(event.toolName)) usedShell = true
      recorder.onEvent(event)
    }

    if (options.turnId) deps.claimTurnUsage(session.id, options.turnId)
    let result: RunAndCaptureResult | undefined
    let runError: string | undefined
    try {
      result = await deps.runTurn(session.id, task.prompt, options, {
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        onEvent,
        onPermissionRequest,
        onToolResultReview,
        execution: {
          kind: "subagent",
          label: `Harness probe ${label}`,
          runId: run.id,
          taskId: `${run.id}:${label}`,
          ...(run.projectId ? { projectId: run.projectId } : {}),
        },
      })
      if (result.resultSubtype?.startsWith("error")) {
        runError = `The turn ended with ${result.resultSubtype}`
      }
    } catch (error) {
      if (input.signal.aborted) throw error
      runError = errorMessage(error)
    } finally {
      const resolvedUsage = result?.usage ?? usageInfo
      usage = await bookProbeUsage(resolvedUsage, {
        operationId: `harness:${run.id}:${label}:${input.attempt}`,
        runId: run.id,
        projectId: run.projectId,
        options,
        sdkLane,
        deps,
      })
      usageBooked = true
    }

    if (usedShell && !options.builtinProcessSandbox && !options.sandboxRuntimeRef) {
      caveats.add(SHELL_UNCONTAINED_CAVEAT)
    }
    const collected = await workspace.collect()
    const profileIds = task.checks.flatMap((c) =>
      c.kind === "acceptance-profile" ? [c.profileId] : []
    )
    const acceptance =
      profileIds.length > 0 && workspace.acceptance
        ? await workspace.acceptance(profileIds, input.signal).catch(() => undefined)
        : undefined
    const traceId = deps.fetchTraceId
      ? await deps.fetchTraceId(session.id).catch(() => undefined)
      : undefined
    finalState = runError ? "failed" : "ready"
    const finalUsage = result?.usage ?? usageInfo
    const evidence = buildExecutionEvidence({
      snapshotId: snapshot.id,
      task,
      environmentFingerprint: input.environmentFingerprint,
      trajectory: recorder.summary(),
      ...(result?.text ? { finalText: result.text } : {}),
      deliverables: collected.deliverables,
      filesObservable: collected.filesObservable,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(finalUsage?.cacheReadInputTokens !== undefined
          ? { cacheReadInputTokens: finalUsage.cacheReadInputTokens }
          : {}),
        ...(usage.costUsd !== undefined ? { totalCostUsd: usage.costUsd } : {}),
      },
      latencyMs: deps.now() - startedAt,
      blockedActions,
      ...(acceptance ? { acceptance } : {}),
      degraded: options.toolSurface === "none",
      ...(runError ? { error: runError } : {}),
      ...(traceId ? { traceId } : {}),
      caveats: [...caveats],
    })
    return { evidence, usage }
  } catch (error) {
    finalState = input.signal.aborted ? "cancelled" : "failed"
    if (!usageBooked && usageInfo) {
      await bookProbeUsage(usageInfo, {
        operationId: `harness:${run.id}:${label}:${input.attempt}`,
        runId: run.id,
        projectId: run.projectId,
        options: undefined,
        sdkLane: false,
        deps,
      }).catch(() => undefined)
    }
    throw error
  } finally {
    await Promise.allSettled([workspace?.release(finalState), deps.deleteSession(session.id)])
    includeInLiveRules()
  }
}

export async function bookProbeUsage(
  usage: UsageInfo | undefined,
  ctx: {
    operationId: string
    runId: string
    projectId?: string
    options: SendOptions | undefined
    sdkLane: boolean
    deps: Pick<ProbeRunnerDeps, "bookUsage" | "surfaceUsageFromUsageInfo">
  }
): Promise<ProbeUsage> {
  if (!usage) return { inputTokens: 0, outputTokens: 0, costUnknown: true }
  const surfaceUsage: SurfaceUsageInput = {
    ...ctx.deps.surfaceUsageFromUsageInfo(usage, { costAuthority: ctx.sdkLane }),
    ...(ctx.options?.model ? { model: ctx.options.model } : {}),
    ...(ctx.options?.provider ? { providerId: ctx.options.provider } : {}),
    ...(ctx.options?.turnId ? { turnId: ctx.options.turnId } : {}),
    runId: ctx.runId,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
  }
  let booking: ProbeUsageBooking | null = null
  try {
    booking = await ctx.deps.bookUsage({
      operationId: ctx.operationId,
      sessionId: `harness:${ctx.runId}`,
      usage: surfaceUsage,
    })
  } catch (error) {
    // A mirror of spend that already happened; the run's own ledger still counts it below.
    console.warn("Harness probe usage booking failed", error)
  }
  // The AI-SDK lane reports zero when the provider gave no cost: unknown, not free.
  const reported =
    usage.totalCostUsd == null || (usage.totalCostUsd === 0 && !ctx.sdkLane)
      ? undefined
      : usage.totalCostUsd
  const priced = booking && booking.costKnown ? booking.costUsd : undefined
  const costUsd = reported ?? priced
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
    costUnknown: costUsd === undefined,
  }
}

/**
 * The plugin tools and MCP server names probes see, discovered from one
 * resolution of the agent under the probe grant. Run once per run: the
 * agent's execution configuration (and so its tool surface) is the same for
 * every harness the run probes.
 */
export async function discoverProbeToolSurface(
  input: {
    run: Pick<HarnessEvolutionRun, "id" | "task" | "config" | "projectId">
    snapshot: Pick<HarnessSnapshotV1, "id" | "components">
    baseCharacter: Character
    carriedSkillIds: readonly string[]
  },
  deps: Pick<
    ProbeRunnerDeps,
    "createSession" | "deleteSession" | "getSettings" | "resolveSendOptions" | "now" | "newId"
  >
): Promise<ProbeToolSurface> {
  const { probePluginToolDenials } = await import("./probe-policy")
  const session = await deps.createSession({
    title: "Harness probe surface",
    characterId: input.baseCharacter.id,
    memoryLearn: false,
    visibility: "embedded",
  })
  try {
    const materialized = materializeHarnessRun(
      input.snapshot,
      input.baseCharacter,
      deps.now(),
      input.carriedSkillIds
    )
    const options = await deps.resolveSendOptions({
      session,
      character: materialized.character,
      appSettings: await deps.getSettings(),
      agentKind: "system",
      routingSurface: "agent",
      capabilityGrants: [
        probeCapabilityGrant({
          runId: input.run.id,
          label: "surface",
          isolation: input.run.task.isolation,
          policy: input.run.config.probe,
          maxTurns: input.run.config.budget.maxTurnsPerRollout,
        }),
      ],
      harnessOverlay: materialized.overlay,
      skillRenderMode: "hybrid",
      turnId: deps.newId(),
    })
    const builtinServers = new Set(["cognia-tools", "cognia-plugin-tools", "a2ui-bridge"])
    return {
      pluginToolDenials: probePluginToolDenials(options.pluginTools),
      allowedMcpServerNames: Object.keys(options.mcpServers ?? {})
        .filter((name) => !builtinServers.has(name))
        .sort(),
    }
  } finally {
    await deps.deleteSession(session.id).catch(() => undefined)
  }
}

/** Production dependencies. */
export async function defaultProbeRunnerDeps(): Promise<ProbeRunnerDeps> {
  const [sessions, settings, buildOptions, runner, claims, usageDb, traces, isolation, home] =
    await Promise.all([
      import("@/lib/db/sessions"),
      import("@/lib/db/settings"),
      import("@/lib/claude/build-options"),
      import("@/lib/claude/run-and-capture"),
      import("@/lib/usage/claimed-turn-usage"),
      import("@/lib/db/session-usage"),
      import("@/lib/db/agent-traces"),
      import("./isolation"),
      import("@/lib/memory/external/home"),
    ])
  return {
    isolation: await isolation.defaultIsolationDeps(),
    createSession: (partial) => sessions.createSession(partial),
    deleteSession: (id) => sessions.deleteSession(id),
    getSettings: async () => (await settings.getSettings()) ?? null,
    resolveSendOptions: (ctx) => buildOptions.resolveSendOptions(ctx),
    runTurn: (sessionId, prompt, options, cap) =>
      runner.runAndCaptureAssistantReply(sessionId, prompt, options, cap),
    claimTurnUsage: claims.claimTurnUsage,
    bookUsage: async ({ operationId, sessionId, usage }) => {
      const row = await usageDb.recordSurfaceUsage({
        surface: PROBE_USAGE_SURFACE,
        operationId,
        sessionId,
        usage,
      })
      return row ? { costUsd: row.costUsd, costKnown: row.costKnown !== false } : null
    },
    surfaceUsageFromUsageInfo: usageDb.surfaceUsageFromUsageInfo,
    homeDir: async () => (await home.defaultHomeDir()) ?? undefined,
    fetchTraceId: async (sessionId) => (await traces.queryBySession(sessionId, 1))[0]?.traceId,
    now: Date.now,
    newId: () => crypto.randomUUID(),
  }
}
