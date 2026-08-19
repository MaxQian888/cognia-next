/**
 * External Bridge handlers — orchestration tools (Thread D).
 *
 * Let an external coding agent drive Cognia's OWN agent runtime:
 *  - `agent_dispatch` — run a built-in / plugin subagent (`subagentId`) or a
 *    character (`characterId`, full `resolveSendOptions` pipeline) headlessly.
 *  - `team_run` — start an Agent Team headlessly.
 *  - `plugin_tool_invoke` — invoke a plugin-registered tool (the plugin's own
 *    consent gate + ownership check still apply per call).
 *
 * # Wire path
 *
 * The orchestration entry points (`executeAgent`, `agentTeamManager`,
 * `getPluginManager`) live in the RENDERER, not the Node MCP sidecar.
 *  - When invoked from the renderer (or a test mount) — `isTauri()` true — the
 *    handler runs the real entry point directly via the `*Core` functions.
 *  - From the production Node sidecar — `isTauri()` false — it forwards the call
 *    over the `orchestration_proxy` socket (Thread D4): sidecar → Rust → renderer
 *    dispatch provider → `*Core` → back. `proxyToRenderer` returns the same
 *    output shape. When the proxy env is absent (web/mobile, standalone npm
 *    plugin) it returns a structured desktop-required error.
 *
 * The `*Core` functions are the single source of truth for validation +
 * execution: both the renderer-direct path and the renderer dispatch provider
 * (running the sidecar's proxied request) call them, so PII redaction fires on
 * BOTH paths and the redacted text is what crosses back over the socket.
 *
 * PII: `agent_dispatch` / `team_run` can surface twin / shared-memory context
 * outward, so the returned text is run through the redaction gate
 * (`packages/redact/src/index.ts`) inside `*Core` before it leaves the boundary.
 */

import { isTauri } from "@/lib/tauri"
import { proxyToRenderer } from "@/lib/external-bridge/orchestration-proxy-client"

// ---------------------------------------------------------------------------
// agent_dispatch
// ---------------------------------------------------------------------------

export interface AgentDispatchInput {
  /** Run a registered subagent by id. */
  subagentId?: string
  /** Or run a character through the full resolveSendOptions pipeline. */
  characterId?: string
  /** The prompt for the dispatched run. */
  prompt: string
  /** Tool-enabled sidecar loop (default true). */
  toolsEnabled?: boolean
  /** Working directory for the run. */
  cwd?: string
}

export interface AgentDispatchOutput {
  ok: boolean
  text?: string
  channel?: string
  finishReason?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  /** True iff the returned text was PII-redacted on the way out. */
  redacted?: boolean
  error?: string
}

export async function agentDispatch(input: AgentDispatchInput): Promise<AgentDispatchOutput> {
  if (isTauri()) return agentDispatchCore(input)
  return proxyToRenderer<AgentDispatchOutput>("agent_dispatch", { ...input })
}

/**
 * Renderer-side `agent_dispatch` execution (validation + run + PII gate). Called
 * directly on the renderer path AND by the dispatch provider for the sidecar's
 * proxied request — so redaction fires on both paths.
 */
export async function agentDispatchCore(input: AgentDispatchInput): Promise<AgentDispatchOutput> {
  if (!input.prompt || !input.prompt.trim()) {
    return { ok: false, error: "agent_dispatch requires a non-empty prompt" }
  }
  if (!input.subagentId && !input.characterId) {
    return { ok: false, error: "agent_dispatch requires either subagentId or characterId" }
  }

  try {
    const { hasNoLeakingPii, redactText } = await import("@cognia/redact")
    if (!hasNoLeakingPii(input.prompt)) {
      return { ok: false, error: "agent_dispatch prompt failed the outbound PII gate" }
    }

    let text: string
    let channel: string | undefined
    let finishReason: string | undefined
    let usage: AgentDispatchOutput["usage"]

    if (input.subagentId) {
      const { dispatchSubagent } = await import("@/lib/plugin/agent-sdk/dispatch")
      const result = await dispatchSubagent(input.subagentId, input.prompt, {
        toolsEnabled: input.toolsEnabled ?? true,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      })
      text = result.text
      channel = result.channel
      finishReason = result.finishReason
      usage = result.usage
    } else {
      const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
      const result = await executeAgent(input.prompt, {
        characterId: input.characterId,
        toolsEnabled: input.toolsEnabled ?? true,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      })
      text = result.text
      channel = result.channel
      finishReason = result.finishReason
      usage = result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined
    }

    // Outward PII gate: substitute placeholders for any leaked PII before the
    // text crosses to the external CLI.
    const { redacted, map } = redactText(text ?? "")
    const wasRedacted = Object.keys(map).length > 0

    return {
      ok: true,
      text: redacted,
      ...(channel ? { channel } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
      ...(wasRedacted ? { redacted: true } : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// team_run
// ---------------------------------------------------------------------------

export interface TeamRunInput {
  teamId: string
  ultracode?: boolean
  /**
   * Structured claimant identity (ADR 0061 P4). Optional — the MCP bridge
   * defaults to `{ kind: "external-agent", id: "external-bridge" }`; future
   * device-originated claims pass their paired-device identity.
   */
  claimant?: import("@/types/agent/agent-team").TeamPickupClaimant
}

/** How long a claim may sit undispatched before the pickup re-advertises. */
const CLAIM_LEASE_MS = 10 * 60_000

/**
 * A pickup is free when never claimed, or when a prior claim's lease
 * expired while the team never left `idle` — the claimant died between
 * claim and dispatch (ADR 0061 P4 contention rule).
 */
export function isPickupFree(
  pickup: import("@/types/agent/agent-team").TeamExternalPickup | undefined,
  teamStatus: string,
  nowMs: number = Date.now()
): boolean {
  if (!pickup) return false
  if (!pickup.claimedAt) return true
  if (!pickup.claimLeaseExpiresAt) return false
  return new Date(pickup.claimLeaseExpiresAt).getTime() < nowMs && teamStatus === "idle"
}

export interface TeamRunOutput {
  ok: boolean
  teamId?: string
  status?: string
  error?: string
}

export async function teamRun(input: TeamRunInput): Promise<TeamRunOutput> {
  if (isTauri()) return teamRunCore(input)
  return proxyToRenderer<TeamRunOutput>("team_run", { ...input })
}

/** Renderer-side `team_run` execution. See {@link agentDispatchCore}. */
export async function teamRunCore(input: TeamRunInput): Promise<TeamRunOutput> {
  if (!input.teamId) return { ok: false, error: "team_run requires a teamId" }

  try {
    // External-handoff pickup: stamp the claim idempotently BEFORE dispatch so
    // `team_list` stops advertising the team. A second run never overwrites a
    // LIVE claim; an expired claim lease on a still-idle team re-claims
    // (ADR 0061 P4 contention rule). A pickup addressed to a specific
    // executor (`targetId`) rejects other claimants.
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const store = useAgentTeamStore.getState()
    const team = store.teams[input.teamId]
    const claimant = input.claimant ?? { kind: "external-agent" as const, id: "external-bridge" }
    if (team?.externalPickup) {
      const pickup = team.externalPickup
      if (pickup.targetId && pickup.targetId !== claimant.id) {
        return {
          ok: false,
          error: `this pickup is addressed to '${pickup.targetId}'`,
        }
      }
      if (isPickupFree(pickup, team.status)) {
        store.updateTeam(input.teamId, {
          externalPickup: {
            ...pickup,
            claimedBy: claimant.id,
            claimant,
            claimedAt: new Date(),
            claimLeaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
          },
        })
      }
    }

    const { runTeam } = await import("@/lib/plugin/agent-sdk/dispatch")
    const result = await runTeam(input.teamId, {
      origin: "external",
      ...(input.ultracode !== undefined ? { ultracode: input.ultracode } : {}),
    })
    return { ok: true, teamId: result.teamId, status: result.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// team_list
// ---------------------------------------------------------------------------

export interface TeamListInput {
  /** Only teams marked for external pickup that no agent has claimed yet. */
  awaitingExternalOnly?: boolean
}

export interface TeamListOutput {
  ok: boolean
  teams?: Array<{
    id: string
    name: string
    status: string
    /** PII-redacted objective (the team's `task`). */
    objective: string
    awaitingExternalPickup: boolean
    requestedAt?: string
    claimedBy?: string
  }>
  error?: string
}

export async function teamList(input: TeamListInput = {}): Promise<TeamListOutput> {
  if (isTauri()) return teamListCore(input)
  return proxyToRenderer<TeamListOutput>("team_list", { ...input })
}

/**
 * Renderer-side `team_list` execution. Reads the AGENT-TEAM store (the
 * runnable entity `team_run` accepts) — NOT the Dexie `teams` table, which
 * holds character chat-teams. Name + objective are PII-redacted before they
 * cross the boundary, mirroring {@link agentDispatchCore}'s outward gate.
 */
export async function teamListCore(input: TeamListInput = {}): Promise<TeamListOutput> {
  try {
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const { redactText } = await import("@cognia/redact")
    const teams = Object.values(useAgentTeamStore.getState().teams)
    const rows = teams
      .filter(
        (team) => !input.awaitingExternalOnly || isPickupFree(team.externalPickup, team.status)
      )
      .map((team) => {
        // Persist layer round-trips Dates as ISO strings — tolerate both.
        const requestedAt = team.externalPickup?.requestedAt
        return {
          id: team.id,
          name: redactText(team.name ?? "").redacted,
          status: team.status,
          objective: redactText(team.task ?? "").redacted,
          // ADR 0061 P4: an expired claim lease on a still-idle team
          // re-advertises the pickup (the claimant died pre-dispatch).
          awaitingExternalPickup: isPickupFree(team.externalPickup, team.status),
          ...(requestedAt ? { requestedAt: new Date(requestedAt).toISOString() } : {}),
          ...(team.externalPickup?.claimedBy ? { claimedBy: team.externalPickup.claimedBy } : {}),
          ...(team.externalPickup?.claimant ? { claimant: team.externalPickup.claimant } : {}),
          ...(team.externalPickup?.targetId ? { targetId: team.externalPickup.targetId } : {}),
        }
      })
    return { ok: true, teams: rows }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// plan_list / plan_run  (ADR-0045)
//
// The bridge could drive teams and scheduled tasks but not plans — the app's
// canonical IR for multi-step work, and the thing a goal or a team projects
// into. These two mirror `team_list` / `team_run` exactly: list what is
// runnable (PII-redacted), then run one headlessly.
// ---------------------------------------------------------------------------

export interface PlanListInput {
  /** Only plans still waiting for a decision (`awaiting_approval`). */
  awaitingApprovalOnly?: boolean
  /** Cap on returned rows (default 50). */
  limit?: number
}

export interface PlanListOutput {
  ok: boolean
  plans?: Array<{
    id: string
    /** PII-redacted plan title. */
    title: string
    status: string
    source: string
    executionMode: string
    totalSteps: number
    completedSteps: number
  }>
  error?: string
}

export async function planList(input: PlanListInput = {}): Promise<PlanListOutput> {
  if (isTauri()) return planListCore(input)
  return proxyToRenderer<PlanListOutput>("plan_list", { ...input })
}

/** Renderer-side `plan_list`. Titles are redacted before crossing the boundary. */
export async function planListCore(input: PlanListInput = {}): Promise<PlanListOutput> {
  try {
    const [{ listAllPlans }, { redactText }] = await Promise.all([
      import("@/lib/db/plans"),
      import("@cognia/redact"),
    ])
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200))
    const rows = (await listAllPlans(limit))
      .filter((plan) => !input.awaitingApprovalOnly || plan.status === "awaiting_approval")
      .map((plan) => ({
        id: plan.id,
        title: redactText(plan.title ?? "").redacted,
        status: plan.status,
        source: plan.source,
        executionMode: plan.executionMode,
        totalSteps: plan.totalSteps,
        completedSteps: plan.completedSteps,
      }))
    return { ok: true, plans: rows }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface PlanRunInput {
  planId: string
  /**
   * Approve the plan first when it is still awaiting a decision. Default
   * false: an external agent must not silently answer a gate a human was
   * asked to answer — it has to say so.
   */
  approve?: boolean
}

export interface PlanRunOutput {
  ok: boolean
  planId?: string
  status?: string
  error?: string
}

export async function planRun(input: PlanRunInput): Promise<PlanRunOutput> {
  if (isTauri()) return planRunCore(input)
  return proxyToRenderer<PlanRunOutput>("plan_run", { ...input })
}

/**
 * Renderer-side `plan_run`. Runs the ORCHESTRATED path (`runPlan`) — the
 * headless one. An in-session plan is driven by visible chat turns, which an
 * external caller has no seat at, so it is refused with an explanation rather
 * than half-executed.
 */
export async function planRunCore(input: PlanRunInput): Promise<PlanRunOutput> {
  if (!input.planId) return { ok: false, error: "plan_run requires a planId" }
  try {
    const [{ getPlanRuntime }, { resolvePlanStrategy }, { findPlanPiiLeak }] = await Promise.all([
      import("@/lib/agent/plan/runtime"),
      import("@/lib/agent/plan/strategy"),
      import("@/lib/agent/plan/pii-gate"),
    ])
    const runtime = getPlanRuntime()
    const plan = await runtime.getPlan(input.planId)
    if (!plan) return { ok: false, error: `plan '${input.planId}' not found` }
    if (resolvePlanStrategy(plan) !== "orchestrated") {
      return {
        ok: false,
        error: "this plan runs as visible turns in its chat session; it cannot be run headlessly",
      }
    }
    const piiLeak = findPlanPiiLeak(plan)
    if (piiLeak) {
      return {
        ok: false,
        planId: plan.id,
        status: plan.status,
        error: `plan_run blocked: plan contains PII at ${piiLeak}`,
      }
    }
    if (plan.status === "awaiting_approval" || plan.status === "draft") {
      if (!input.approve) {
        return {
          ok: false,
          planId: plan.id,
          status: plan.status,
          error: "plan is awaiting approval — re-call with approve: true to approve and run it",
        }
      }
      await runtime.approvePlan(plan.id)
    }
    const result = await runtime.runPlan(plan.id)
    return { ok: true, planId: plan.id, status: result?.status ?? "unknown" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// plugin_tool_invoke
// ---------------------------------------------------------------------------

export interface PluginToolInvokeInput {
  pluginId: string
  toolName: string
  args?: Record<string, unknown>
  /** Optional human-readable reason recorded with the consent prompt. */
  reason?: string
}

export interface PluginToolInvokeOutput {
  ok: boolean
  result?: unknown
  error?: string
  /** Typed PluginToolInvocationError code when ok === false. */
  code?: string
}

export async function pluginToolInvoke(
  input: PluginToolInvokeInput
): Promise<PluginToolInvokeOutput> {
  if (isTauri()) return pluginToolInvokeCore(input)
  return proxyToRenderer<PluginToolInvokeOutput>("plugin_tool_invoke", { ...input })
}

/** Renderer-side `plugin_tool_invoke` execution. See {@link agentDispatchCore}. */
export async function pluginToolInvokeCore(
  input: PluginToolInvokeInput
): Promise<PluginToolInvokeOutput> {
  if (!input.pluginId || !input.toolName) {
    return { ok: false, error: "plugin_tool_invoke requires pluginId and toolName" }
  }

  try {
    const { invokePluginTool } = await import("@/lib/plugin/core/invoke-plugin-tool")
    const result = await invokePluginTool(input.pluginId, input.toolName, input.args ?? {}, {
      ...(input.reason ? { reason: input.reason } : {}),
    })
    return { ok: true, result }
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(code ? { code } : {}),
    }
  }
}

// ---------------------------------------------------------------------------
// Renderer dispatch entry — runs the `*Core` for a sidecar-proxied request.
// ---------------------------------------------------------------------------

type HostOperation = (...args: unknown[]) => unknown | Promise<unknown>

const hostOperationLoaders: Record<string, () => Promise<HostOperation>> = {
  wikiSearch: async () => (await import("./wiki")).wikiSearch as HostOperation,
  wikiRead: async () => (await import("./wiki")).wikiRead as HostOperation,
  ragSearch: async () => (await import("./rag")).ragSearch as HostOperation,
  runtimeQuery: async () => (await import("./runtime")).runtimeQuery as HostOperation,
  agentDispatch: async () => agentDispatchCore as HostOperation,
  teamRun: async () => teamRunCore as HostOperation,
  teamList: async () => teamListCore as HostOperation,
  planList: async () => planListCore as HostOperation,
  planRun: async () => planRunCore as HostOperation,
  pluginToolInvoke: async () => pluginToolInvokeCore as HostOperation,
  spawnTask: async () => (await import("./spawn-task")).spawnTaskCore as HostOperation,
  scheduleTask: async () => (await import("./scheduling")).scheduleTaskCore as HostOperation,
  listScheduledTasks: async () =>
    (await import("./scheduling")).listScheduledTasksCore as HostOperation,
  cancelScheduledTask: async () =>
    (await import("./scheduling")).cancelScheduledTaskCore as HostOperation,
  connectorsListAdapters: async () =>
    (await import("./connectors")).connectorsListAdapters as HostOperation,
  connectorsListConversations: async () =>
    (await import("./connectors")).connectorsListConversations as HostOperation,
  connectorsGetAudit: async () =>
    (await import("./connectors")).connectorsGetAudit as HostOperation,
  connectorsExportAudit: async () =>
    (await import("./connectors")).connectorsExportAudit as HostOperation,
  connectorsListDrafts: async () =>
    (await import("./connectors")).connectorsListDrafts as HostOperation,
  connectorsSendMessage: async () =>
    (await import("./connectors")).connectorsSendMessage as HostOperation,
  recordLesson: async () => (await import("./inbound")).recordLesson as HostOperation,
  saveSkillDraft: async () => (await import("./inbound")).saveSkillDraft as HostOperation,
  ingestNote: async () => (await import("./inbound")).ingestNote as HostOperation,
  memorySearch: async () => (await import("./memory")).memorySearch as HostOperation,
  memoryList: async () => (await import("./memory")).memoryList as HostOperation,
  memoryStore: async () => (await import("./memory")).memoryStore as HostOperation,
  memoryUpdate: async () => (await import("./memory")).memoryUpdate as HostOperation,
  memoryForget: async () => (await import("./memory")).memoryForget as HostOperation,
  listAllWikiArticles: async () =>
    (await import("@/lib/db/wiki-articles")).listAllWikiArticles as HostOperation,
  getWikiArticleBySlug: async () =>
    (await import("@/lib/db/wiki-articles")).getWikiArticleBySlug as HostOperation,
  listSkills: async () => (await import("@/lib/db/skills")).listSkills as HostOperation,
  getSkill: async () => (await import("@/lib/db/skills")).getSkill as HostOperation,
  listCharacters: async () => (await import("@/lib/db/characters")).listCharacters as HostOperation,
  getCharacter: async () => (await import("@/lib/db/characters")).getCharacter as HostOperation,
  recordCall: async () => (await import("../audit-log")).recordCall as HostOperation,
  workflowListDeployments: async () =>
    (await import("./workflow")).listWorkflowDeploymentsCore as HostOperation,
  workflowRunCreate: async () =>
    (await import("./workflow")).createWorkflowRunCore as HostOperation,
  workflowRunGet: async () => (await import("./workflow")).getWorkflowRunCore as HostOperation,
  workflowEventsList: async () =>
    (await import("./workflow")).listWorkflowEventsCore as HostOperation,
  workflowRunCancel: async () =>
    (await import("./workflow")).cancelWorkflowRunCore as HostOperation,
}

/**
 * Execute one orchestration command on the renderer for the sidecar's proxied
 * request (Thread D4). The dispatch provider calls this with the `command` +
 * `args` carried in the `orchestration-proxy:exec` event and posts the returned
 * output back to Rust. Unknown commands return a structured error rather than
 * throwing so the round-trip always resolves.
 */
export async function runOrchestrationExec(
  command: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const hostOperationLoader = hostOperationLoaders[command]
  if (hostOperationLoader) {
    if (!Array.isArray(args.arguments)) {
      return { ok: false, error: `host command '${command}' requires an arguments array` }
    }
    const operation = await hostOperationLoader()
    const result = await operation(...args.arguments)
    const { hasNoLeakingPiiDeep } = await import("@cognia/redact")
    return hasNoLeakingPiiDeep(result)
      ? result
      : { ok: false, error: `host command '${command}' response failed the outbound PII gate` }
  }

  switch (command) {
    case "agent_dispatch":
      return agentDispatchCore(args as unknown as AgentDispatchInput)
    case "spawn_task":
      return (await import("./spawn-task")).spawnTaskCore(
        args as unknown as import("./spawn-task").SpawnTaskInput
      )
    case "team_run":
      return teamRunCore(args as unknown as TeamRunInput)
    case "team_list":
      return teamListCore(args as unknown as TeamListInput)
    case "plan_list":
      return planListCore(args as unknown as PlanListInput)
    case "plan_run":
      return planRunCore(args as unknown as PlanRunInput)
    case "plugin_tool_invoke":
      return pluginToolInvokeCore(args as unknown as PluginToolInvokeInput)
    case "schedule_task":
      return (await import("./scheduling")).scheduleTaskCore(
        args as unknown as import("./scheduling").ScheduleTaskInput
      )
    case "list_scheduled_tasks":
      return (await import("./scheduling")).listScheduledTasksCore(
        args as unknown as import("./scheduling").ListScheduledTasksInput
      )
    case "cancel_scheduled_task":
      return (await import("./scheduling")).cancelScheduledTaskCore(
        args as unknown as import("./scheduling").CancelScheduledTaskInput
      )
    default:
      return { ok: false, error: `unknown orchestration command: ${command}` }
  }
}
