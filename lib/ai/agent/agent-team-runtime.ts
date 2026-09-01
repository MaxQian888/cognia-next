/**
 * Agent Team runtime — F-path synthesizer (ADR-0022).
 *
 * Translates a team + its tasks into a synthesized VisualWorkflow, registers
 * per-run shared state (TeammatePool / BudgetGuard / TeamNotifier / dynamic
 * controllers) in the TeamRunContext WeakMap, and delegates execution to
 * runWorkflow. Plan-approval, deadlock, budget, and teammate-fix gates stay
 * in this synthesizer — they're team-specific and don't leak to other
 * workflow consumers.
 *
 * Per ADR-0022 §3.8.
 */

import { nanoid } from "nanoid"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"
import { approve as approveBus, reject as rejectBus } from "@/lib/runtime/approval-bus"
import { waitForDecision } from "@/lib/runtime/approval-bus"
import {
  buildKnownCapabilityIds,
  validateInstanceCapabilitiesWith,
  refreshAllInstanceCapabilityWarnings,
} from "@/lib/ai/agent/team/capability-audit"
import { runWorkflow, type RunWorkflowResult } from "@/lib/workflow/runtime/orchestrator"
import type { VisualWorkflow, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { createConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import { createModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import { cheapModelHintFromSettings } from "@/lib/ai/routing/cheap-model-hint"
import { createTeammatePool } from "./team/teammate-pool"
import { resolveTeamTwinRuntime } from "./team/twin-context"
import { createTeamNotifier, type TeamNotifierDeps } from "./team/team-notifier"
import {
  registerTeamRunContext,
  unregisterTeamRunContext,
  getTeamRunContext,
  type TeamStoreWriter,
} from "./team/team-run-context"
import { synthesizeTeamWorkflow } from "./team/synthesize-workflow"
import { applyGateBehavior, resolveGatePolicy, type TeamRunOrigin } from "./team/gate-policy"
import { buildTeamRiskInput } from "./team/risk-input"
import { isTaskReviewEnabled } from "./team/task-review-policy"
import { classifyRisk } from "@/lib/policy/risk/classify-risk"
import { requiredCeremony } from "@/lib/policy/risk/ceremony"
import { createDeadlockHandler } from "./team/deadlock-gate"
import { runTeamWaves } from "./team/team-wave-runner"
import { createLedgerCheckpoint } from "./team/progress-ledger-checkpoint"
import {
  RateLimitResumeController,
  createRealResumeDeps,
  NUDGE_CONTINUE_PROMPT,
} from "./team/rate-limit-resume"
import { isUltracodeActive, type UltracodeOverride } from "./team/ultracode-trigger"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"

/** Planning result kept compatible with the legacy LeadPlanResult shape. */
export interface LeadPlanResult {
  planText: string
  tokenUsage?: SubAgentTokenUsage
}

export interface RunTeamLifecycleDeps {
  /** Optional caller-allocated id used to bind an inbound job before side effects begin. */
  runId?: string
  storeReader: {
    getTeam(teamId: string): AgentTeam | undefined
    getTeammates(teamId: string): AgentTeammate[]
    getTeamTasks(teamId: string): AgentTeamTask[]
  }
  storeWriter: TeamStoreWriter
  /**
   * Called when the plan-approval gate is open — i.e. when
   * `team.config.requirePlanApproval` is set OR the risk assessment raised it
   * (ADR-0070), so this fires for teams that never set the flag.
   */
  runLeadPlanning?: (params: {
    team: AgentTeam
    lead: AgentTeammate
    feedback?: string
    signal: AbortSignal
  }) => Promise<LeadPlanResult>
  /**
   * Ask the lead to review one task's work (ADR-0071). Only called when
   * `team.config.taskReview.enabled`. Reaches the review node through
   * `TeamRunContext.runLeadReview`.
   */
  runLeadReview?: (params: {
    team: AgentTeam
    lead: AgentTeammate
    task: import("./team/lead-review").LeadReviewTask
    workerName?: string
    workerOutput: string
    evidence: import("./team/review-evidence").ReviewEvidence
    revision: number
    previousFeedback?: string
    signal: AbortSignal
  }) => Promise<import("./team/lead-review").LeadReviewVerdict>
  /** Wired by buildAgentTeamRuntimeDeps in production. */
  notifierDeps?: TeamNotifierDeps
  /**
   * Origin of this team run when it was triggered from an IM channel
   * (e.g. an `action.team.run` node inside a workflow that
   * `startWorkflowFromIM` kicked off). Threaded onto the synthesized team
   * `runWorkflow` as `triggeredBy` so the execution bridge +
   * run-presentation runner fan the team's progress + final result back
   * to the originating conversation. Omitted for UI / API runs, which keeps
   * their behavior unchanged (no IM fan-out).
   */
  triggeredFrom?: WorkflowTriggeredFrom
  /**
   * Where this run was triggered from. Headless origins (scheduler / remote /
   * external / plugin / im / delegation) resolve the HITL gates through
   * `resolveGatePolicy` instead of blocking on a modal nobody is watching —
   * see `team/gate-policy.ts`. Defaults to "im" when `triggeredFrom.source`
   * is "im", else "interactive" (unchanged behavior for UI runs).
   */
  origin?: TeamRunOrigin
  /**
   * Ask a human about the lead's plan through the run's OWN surface.
   *
   * Supplying it is the caller's proof that a reachable human exists — which
   * is what flips the gate policy from `fail-fast` to `delegate`. `resolveGatePolicy`
   * defaults to no channel, so every existing caller keeps today's behaviour.
   */
  planApprovalDelegate?: (request: {
    planText: string
    revision: number
    riskReason?: string
  }) => Promise<import("@/lib/runtime/approval-bus").ApprovalDecision>
  /**
   * Ceremony the OPERATOR's autonomy level owes, independent of risk
   * (ADR-0070 + the autonomy axis). ORed with the risk-derived gate and the
   * team's own flag, never subtracted from either — a permissive autonomy
   * level must not be able to cancel a gate risk raised.
   */
  requirePlanApprovalFloor?: boolean
  /**
   * Operator override for ultracode orchestration (ADR-0022 addendum).
   * `"force"` runs the ultracode pattern composition regardless of autoMode;
   * `"off"` forces the flat task DAG. Omitted → the team's `ultracode.autoMode`
   * + routing assessment decide (see `isUltracodeActive`).
   */
  ultracodeOverride?: UltracodeOverride
  /**
   * Optional run-scoped agent-trace id (eval target). Threaded onto the
   * TeamRunContext so every teammate dispatch emits its span under this trace,
   * letting the caller assemble the run via `queryByTrace`.
   */
  traceId?: string
  /** Parent IM ceiling inherited by every teammate dispatch in this run. */
  parentPermissionCeiling?: import("@/types/agent/permission-ceiling").AgentPermissionCeiling
  /**
   * The conversation's resolved working directory (ADR-0144), when the surface
   * that started this run has one.
   *
   * A Squad is an executor a conversation is handed to, and the conversation
   * already answers "where does work happen" through
   * `resolveEffectiveCwdForSession` — its workspace root, its editor pin, its
   * project. The team's own `config.workingDir` was written once when the
   * Squad was configured and knows none of that, so a Squad run started from a
   * conversation in workspace B used to work in whatever directory the Squad
   * was set up with.
   *
   * Only consulted when the Squad has no explicitly configured repositories:
   * a Squad that names its own repositories is stating where it works, and
   * that statement outranks the caller's ambient directory.
   */
  sessionWorkingDir?: string
  /**
   * Depth of the team-completion → workflow → team chain that produced this
   * run (0 = root). Threaded by the `action.team.run` executor from the
   * outer run's `trigger.payload.chainDepth`; the terminal `trigger.team`
   * fan-out stops past MAX_TEAM_TRIGGER_CHAIN_DEPTH (loop guard).
   */
  triggerChainDepth?: number
  /**
   * PR feedback loop seams (ADR — team PR feedback). Wired by
   * `configureAgentTeamRuntime` on desktop; absence disables the loop (so it is
   * inert on web / when unconfigured). `resolveTeamRepo` maps the team's
   * workingDir to its GitHub repo + default branch (from the origin remote);
   * `resolvePrObserveOctokit` mints a request-ready client for that repo;
   * `runPrReview` runs the internal reviewer (dispatchStructured-backed).
   */
  resolveTeamRepo?: (
    workingDir: string
  ) => Promise<{ fullName: string; defaultBranch: string } | null>
  resolvePrObserveOctokit?: (
    repoFullName: string
  ) => Promise<import("@/lib/github/pr-observe/types").OctokitLike | null>
  runPrReview?: import("./team/pr-feedback/reviewer").RunReview
  /**
   * Optional filter applied to the team's task list before synthesis — used
   * by `agentTeamManager.resume()` to skip already-done work. Filtered-out
   * task ids are threaded as `satisfiedDependencyIds` so surviving tasks that
   * depend on them synthesize cleanly (their blackboard results remain
   * readable via `readDependencyResults`). Omitted → all tasks run
   * (unchanged behavior).
   */
  taskFilter?: (task: AgentTeamTask) => boolean
}

export interface RunTeamLifecycleResult {
  /** Matches the workflowRuns row id; UI navigation key. */
  runId: string
  status: "completed" | "failed" | "cancelled"
  reason?: string
  /** The synthesized workflow's terminal output (e.g. `{ report }` for ultracode). */
  output?: unknown
  /** Echo of the run-scoped trace id when one was supplied. */
  traceId?: string
}

const inflightControllers = new Map<string, AbortController>()

export function getInflightController(teamId: string): AbortController | undefined {
  return inflightControllers.get(teamId)
}

/** Strict JSON-fenced-block parser preserved from the legacy runtime. */
export function parseProposedPlan(
  text: string
): { ok: true; plan: unknown } | { ok: false; reason: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, reason: "empty plan text" }
  }
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
  const candidate = fenceMatch ? fenceMatch[1] : text.trim()
  try {
    const parsed: unknown = JSON.parse(candidate ?? "")
    return { ok: true, plan: parsed }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Resolve + build the PR feedback controller for a run (ADR — team PR feedback).
 *
 * Returns `undefined` (inert) unless a GitHub repo + credentials resolve and the
 * controller builds. Best-effort: any failure is reported via `onWarn` and
 * yields `undefined` — it never throws to the run. Extracted from
 * {@link runTeamLifecycle} so the resolve→build wiring is unit-testable; the
 * module loaders are injectable and default to dynamic `import()` so the
 * pr-feedback code stays out of the main bundle until the loop is used.
 */
export async function buildRunPrFeedback(opts: {
  runId: string
  teamId: string
  config: NonNullable<AgentTeam["config"]["prFeedback"]>
  workingDir: string
  leadId?: string
  nudges?: AgentTeam["config"]["nudges"]
  teammates: Array<{ id: string; name: string }>
  tasks: Array<{ id: string; title?: string }>
  resolveTeamRepo: NonNullable<RunTeamLifecycleDeps["resolveTeamRepo"]>
  resolvePrObserveOctokit: NonNullable<RunTeamLifecycleDeps["resolvePrObserveOctokit"]>
  runPrReview?: RunTeamLifecycleDeps["runPrReview"]
  notify: (n: import("./team/pr-feedback/runtime").PrFeedbackNotifyInput) => void
  addMessage: (m: import("./team/pr-feedback/runtime").PrFeedbackMailboxInput) => void
  onWarn: (message: string) => void
  loadRuntime?: () => Promise<
    Pick<typeof import("./team/pr-feedback/runtime"), "buildTeamPrFeedback">
  >
  loadGit?: () => Promise<Pick<typeof import("@/lib/git/commands"), "gitPush">>
}): Promise<import("./team/pr-feedback/runtime").TeamPrFeedback | undefined> {
  const loadRuntime = opts.loadRuntime ?? (() => import("./team/pr-feedback/runtime"))
  const loadGit = opts.loadGit ?? (() => import("@/lib/git/commands"))
  try {
    const resolved = await opts.resolveTeamRepo(opts.workingDir)
    if (!resolved) return undefined
    const octokit = await opts.resolvePrObserveOctokit(resolved.fullName)
    if (!octokit) return undefined
    const [{ buildTeamPrFeedback }, { gitPush }] = await Promise.all([loadRuntime(), loadGit()])
    return buildTeamPrFeedback({
      runId: opts.runId,
      teamId: opts.teamId,
      ...(opts.leadId ? { leadId: opts.leadId } : {}),
      repo: resolved.fullName,
      baseBranch: resolved.defaultBranch,
      octokit,
      config: opts.config,
      ...(opts.nudges ? { nudges: opts.nudges } : {}),
      teammates: opts.teammates,
      tasks: opts.tasks,
      notify: opts.notify,
      addMessage: opts.addMessage,
      git: { push: (cwd, branch) => gitPush(cwd, { remote: "origin", branch, setUpstream: true }) },
      ...(opts.config.reviewer?.enabled && opts.runPrReview ? { runReview: opts.runPrReview } : {}),
    })
  } catch (err) {
    opts.onWarn(err instanceof Error ? err.message : String(err))
    return undefined
  }
}

export async function runTeamLifecycle(
  teamId: string,
  deps: RunTeamLifecycleDeps,
  externalSignal?: AbortSignal
): Promise<RunTeamLifecycleResult> {
  const previous = inflightControllers.get(teamId)
  if (previous && !previous.signal.aborted) {
    throw new Error(`Team ${teamId} is already running`)
  }
  const ac = new AbortController()
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort(externalSignal.reason)
    else
      externalSignal.addEventListener("abort", () => ac.abort(externalSignal.reason), {
        once: true,
      })
  }
  inflightControllers.set(teamId, ac)

  try {
    if (ac.signal.aborted) {
      return { runId: "", status: "cancelled", reason: "Aborted before start" }
    }
    const storedTeam = deps.storeReader.getTeam(teamId)
    if (!storedTeam) {
      return { runId: "", status: "failed", reason: `Team ${teamId} not found` }
    }
    // Fold the caller's directory in ONCE, here, rather than at each of the
    // four places `config.workingDir` is read (root construction, the durable
    // primary-repository path, and both dispatch paths). A local clone: the
    // store still holds what the Squad was configured with, because the
    // conversation's directory belongs to this run, not to the Squad.
    const team: AgentTeam =
      deps.sessionWorkingDir &&
      !(storedTeam.config.repositories && storedTeam.config.repositories.length > 0)
        ? {
            ...storedTeam,
            config: { ...storedTeam.config, workingDir: deps.sessionWorkingDir },
          }
        : storedTeam
    const allMembers = deps.storeReader.getTeammates(teamId)
    const workers = allMembers.filter((m) => m.role === "teammate")
    if (workers.length === 0) {
      return { runId: "", status: "failed", reason: "No teammates available" }
    }
    const allTasks = deps.storeReader.getTeamTasks(teamId)
    // Resume support: `taskFilter` drops already-done tasks; their ids become
    // externally-satisfied dependencies for synthesis (the wave runner treats
    // absent ids as satisfied natively — see team-wave-runner.ts ready-set).
    const tasks = deps.taskFilter ? allTasks.filter(deps.taskFilter) : allTasks
    const externallySatisfiedIds =
      tasks.length === allTasks.length
        ? undefined
        : new Set(allTasks.filter((t) => !tasks.includes(t)).map((t) => t.id))
    // Ultracode runs are driven by the team objective (team.task string) + a
    // planned pattern composition, not the flat task list — so they don't
    // require pre-seeded tasks. Flat runs still do.
    const ultracodeActive = isUltracodeActive(team, deps.ultracodeOverride)
    if (!ultracodeActive && tasks.length === 0) {
      return { runId: "", status: "failed", reason: "No tasks to dispatch" }
    }

    // ── Allocate runId early so the onTeamStart hook can carry it ──
    const runId = deps.runId ?? `run_team_${nanoid(12)}`
    const origin: TeamRunOrigin =
      deps.origin ?? (deps.triggeredFrom?.source === "im" ? "im" : "interactive")
    const isoCfg = team.config.workspaceIsolation
    const configuredRoots =
      team.config.repositories && team.config.repositories.length > 0
        ? team.config.repositories
            .filter((repository) => repository.writable)
            .map((repository) => ({
              logicalRootId: repository.id,
              sourceRoot: repository.path,
            }))
        : team.config.workingDir
          ? [{ logicalRootId: "primary", sourceRoot: team.config.workingDir }]
          : []
    let workspaceController:
      | import("./team/workspace/registry-controller").AgentTeamRegistryWorkspaceController
      | undefined
    if (configuredRoots.length > 0) {
      const { AgentTeamRegistryWorkspaceController } =
        await import("./team/workspace/registry-controller")
      workspaceController = new AgentTeamRegistryWorkspaceController({
        runId,
        roots: configuredRoots,
        base: isoCfg?.baseRef
          ? { kind: "gitRef", gitRef: isoCfg.baseRef }
          : origin === "interactive"
            ? { kind: "workingState" }
            : { kind: "remoteDefault" },
      })
    }
    let durableEnvironment:
      | NonNullable<import("./team/team-run-context").TeamRunContext["durableEnvironment"]>
      | undefined
    if (team.config.runtimeVersion === "durable-v2") {
      try {
        const { getDurableTeamCoordinator } = await import("./team/durable-runtime")
        await getDurableTeamCoordinator().prepareRun(team, runId)
        if (!team.config.environmentRef) {
          throw new Error("Durable AgentTeam requires an immutable environment version")
        }
        const [{ getProjectEnvironmentVersion }, { createLocalTauriExecutionEnvironment }] =
          await Promise.all([
            import("@/lib/db/project-environments"),
            import("./execution/local-tauri-environment"),
          ])
        const profile = await getProjectEnvironmentVersion(team.config.environmentRef.versionId)
        if (!profile || profile.environmentId !== team.config.environmentRef.environmentId) {
          throw new Error("The selected AgentTeam environment version is unavailable")
        }
        const primary = team.config.repositories?.find(
          (repository) => repository.role === "primary"
        )
        const repositoryPath = primary?.path ?? team.config.workingDir
        if (!repositoryPath) throw new Error("Durable AgentTeam requires a primary repository path")
        // Capability truth comes from the host adapter, never from the team's
        // requested policy. Unsupported sandbox/network guarantees therefore
        // fail closed instead of being treated as capabilities by declaration.
        if (!workspaceController) {
          throw new Error("Durable AgentTeam requires a writable Registry repository")
        }
        const setupAdapter = createLocalTauriExecutionEnvironment()
        const adapter = createLocalTauriExecutionEnvironment({
          // Admission validates and freezes the profile; setup itself runs only
          // after the Registry alias exists, never against the live checkout.
          executeSetup: async () => ({ success: true }),
          openWorkspace: async (input) => {
            const repositoryId =
              configuredRoots.find((root) => root.sourceRoot === input.repositoryPath)
                ?.logicalRootId ??
              primary?.id ??
              "primary"
            const lease = await workspaceController.openDispatch({
              taskId: input.taskId,
              teammateId: input.teammateId,
              repositoryId,
            })
            await setupAdapter.prepare(input.profile.profile, lease.primaryAlias)
            return {
              executionRoot: lease.primaryAlias,
              workspaceRunId: lease.run.runId,
              settle: lease.settle,
            }
          },
        })
        const prepared = await adapter.prepare(profile, repositoryPath)
        durableEnvironment = {
          adapter,
          profile: Object.freeze(structuredClone(profile)),
          preparedByRepository: new Map([[primary?.id ?? "primary", prepared]]),
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const { updateAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
        await updateAgentTeamRun(runId, {
          status: "failed",
          recoveryReason: reason,
          completedAt: Date.now(),
          updatedAt: Date.now(),
        }).catch(() => false)
        const { getExecutionRun, runEventJournal } = await import("@/lib/db/execution-runs")
        const { agentTeamExecutionRunId } = await import("@/lib/execution/agent-team-bridge")
        const executionRunId = agentTeamExecutionRunId(runId)
        if (await getExecutionRun(executionRunId).catch(() => undefined)) {
          await runEventJournal
            .append(executionRunId, {
              id: `execution-event:${runId}:team-terminal:failed`,
              ts: Date.now(),
              type: "run.failed",
              visibility: "summary",
              payload: { summary: "Agent team run failed during durable admission" },
            })
            .catch(() => undefined)
        }
        return { runId, status: "failed", reason }
      }
    }
    const hooks = getPluginLifecycleHooks()
    hooks.dispatchOnTeamStart({
      teamId,
      runId,
      workers: allMembers.map((m) => ({ id: m.id, name: m.name, role: m.role })),
      taskCount: tasks.length,
    })

    // ── Resolve the per-run gate policy from the trigger origin ──
    // Headless origins resolve gates immediately (auto-approve / auto-reject /
    // fail-fast) instead of blocking on a modal nobody is watching.
    const gatePolicy = resolveGatePolicy(origin, {
      approvalChannel: deps.planApprovalDelegate !== undefined,
    })

    // Notifier is created BEFORE the pre-run gates so the capability-audit
    // gate can open its modal (interactive) or emit its warning (headless).
    // It has no dependency on the pool/budget built further down.
    const notifier = createTeamNotifier({ runId, teamId }, deps.notifierDeps)

    // ── Pre-run capability-audit gate ──
    // If any team/teammate references a capability id that no longer resolves
    // (e.g. a contributing plugin was disabled), surface the stale ids and ask
    // the operator to confirm before spending tokens on a degraded run.
    {
      const known = await buildKnownCapabilityIds()
      const auditWarnings = [
        ...validateInstanceCapabilitiesWith(known, team),
        ...workers.flatMap((w) => validateInstanceCapabilitiesWith(known, team, w)),
      ]
      if (auditWarnings.length > 0) {
        // Populate the derived sidecar map so the consent UI + Settings red
        // dots can enumerate exactly which ids are stale.
        void refreshAllInstanceCapabilityWarnings()
        if (gatePolicy.capabilityAudit === "block") {
          // Interactive: open the HITL modal. Without this notify the gate
          // used to wait on a scope no UI ever produced — hanging even on
          // the desktop.
          notifier.notify({
            level: "critical",
            title: "Stale capabilities detected",
            body: `${auditWarnings.length} capability reference(s) no longer resolve (a contributing plugin may be disabled). Run anyway, or cancel to fix the configuration.`,
            runId,
            teamId,
            openApproval: { scope: "agent-team-capability-audit", id: runId },
            dedupeKey: `capability-audit:${runId}`,
          })
        } else {
          notifier.notify({
            level: "warn",
            title: "Proceeding with stale capabilities",
            body: `${auditWarnings.length} capability reference(s) no longer resolve; the ${origin} run continues without them (headless policy).`,
            runId,
            teamId,
            dedupeKey: `capability-audit:${runId}`,
          })
        }
        const decision = await applyGateBehavior(gatePolicy.capabilityAudit, () =>
          waitForDecision({ scope: "agent-team-capability-audit", id: runId }, ac.signal)
        ).catch(() => ({ outcome: "reject" as const }))
        if (decision.outcome !== "approve") {
          return {
            runId: "",
            status: "cancelled",
            reason: "Operator declined to run with stale capabilities",
          }
        }
      }
    }

    // ── Pre-run risk assessment (ADR-0070) ──
    // Deterministic: inspects what the roster can actually reach, never asks a
    // model. Raises the plan-approval gate for a medium/high-risk run even when
    // the operator left `requirePlanApproval` off — a run that will drive the
    // mouse, shell out, or destroy data owes a human a look at the plan first.
    // Low-risk runs are untouched (no new friction), which is why the classifier
    // gates on positive evidence rather than on uncertainty. Note this is
    // origin-blind: an IM-bound run is judged by what its roster can reach, not
    // by the fact that it will reply into the thread it was summoned from.
    const riskAssessment = classifyRisk(buildTeamRiskInput({ team, workers, tasks }))
    const riskRaisedGate =
      (team.config.riskGating ?? true) && requiredCeremony(riskAssessment).requirePlanApproval
    const requirePlanApproval =
      Boolean(team.config.requirePlanApproval) ||
      riskRaisedGate ||
      deps.requirePlanApprovalFloor === true
    // Only explain the gate by its risk when risk is the SOLE cause. An
    // operator who set `requirePlanApproval` already knows why the gate is
    // there; telling them it's the risk assessment would be a lie.
    const gateIsRiskOnly =
      riskRaisedGate && !team.config.requirePlanApproval && deps.requirePlanApprovalFloor !== true

    // ── Plan-approval gate (synthesizer-local; never enters workflow) ──
    if (requirePlanApproval) {
      // Headless: fail fast BEFORE running lead planning — approval without a
      // human is meaningless and planning tokens would be wasted on a run
      // that cannot be approved. Whether the gate was an explicit operator
      // choice or risk-raised, honor it by failing loudly instead of
      // auto-approving; a risky unattended run is exactly what this refuses.
      if (gatePolicy.planApproval !== "block" && gatePolicy.planApproval !== "delegate") {
        const reason = gateIsRiskOnly
          ? `This run touches ${riskAssessment.reason} and cannot proceed unattended (origin=${origin}); run it interactively, or set riskGating=false to opt out`
          : `requirePlanApproval is enabled but this run is headless (origin=${origin}); approve interactively or disable plan approval`
        notifier.notify({
          level: "critical",
          title: "Headless run blocked by plan approval",
          body: reason,
          runId,
          teamId,
          dedupeKey: `plan-approval-headless:${runId}`,
        })
        return { runId: "", status: "failed", reason }
      }
      const lead = allMembers.find((m) => m.id === team.leadId)
      if (!lead) {
        return { runId: "", status: "failed", reason: "Lead teammate not found" }
      }
      if (!deps.runLeadPlanning) {
        return {
          runId: "",
          status: "failed",
          reason: "requirePlanApproval=true but runLeadPlanning dep not provided",
        }
      }
      const maxRev = Math.max(1, team.config.maxPlanRevisions ?? 1)
      let approved = false
      let feedback: string | undefined
      for (let i = 0; i < maxRev; i++) {
        if (ac.signal.aborted) break
        // Every other failure in this block returns a `failed` result; planning
        // was the one that threw straight out of `runTeamLifecycle`, so a
        // misconfigured provider surfaced as an unhandled rejection instead of
        // a run the operator can see failed (and why).
        let planResult: LeadPlanResult
        try {
          planResult = await deps.runLeadPlanning({
            team,
            lead,
            feedback,
            signal: ac.signal,
          })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          notifier.notify({
            level: "critical",
            title: "Lead planning failed",
            body: reason,
            runId,
            teamId,
            dedupeKey: `plan-failed:${runId}`,
          })
          return { runId: "", status: "failed", reason }
        }
        // Publish the plan before waiting: the workspace PlanApprovalPanel
        // renders (and enables Approve/Reject) only while the lead is
        // `awaiting_approval` with a non-empty `proposedPlan`, and the
        // pending-gates modal needs the `openApproval` push — without both
        // producers this gate waits on a decision no UI can ever emit (the
        // same hang the capability-audit comment above records).
        deps.storeWriter.updateTeammate(lead.id, {
          status: "awaiting_approval",
          proposedPlan: planResult.planText,
        })
        notifier.notify({
          level: "critical",
          title: "Plan awaiting approval",
          body: gateIsRiskOnly
            ? `This run touches ${riskAssessment.reason}, so approval is required. Review the lead's plan, or reject with feedback for another revision.`
            : "The lead proposed a plan. Approve to start the run, or reject with feedback for another revision.",
          runId,
          teamId,
          openApproval: { scope: "agent-team", id: teamId },
          dedupeKey: `plan-approval:${runId}:${i}`,
        })
        // `block` waits on the pending-gates modal; `delegate` asks through the
        // surface that started the run. Both land in the same branch below, so
        // a plan approved from a chat thread and one approved from the desktop
        // modal are indistinguishable to everything downstream — including the
        // rejection feedback, which re-enters this loop as the next revision's
        // instruction either way.
        const decision = await applyGateBehavior(
          gatePolicy.planApproval,
          () =>
            waitForDecision({ scope: "agent-team", id: teamId }, ac.signal).catch(() => ({
              outcome: "reject" as const,
              feedback: "aborted",
            })),
          {
            ...(deps.planApprovalDelegate
              ? {
                  delegate: () =>
                    deps.planApprovalDelegate!({
                      planText: planResult.planText,
                      revision: i,
                      ...(gateIsRiskOnly ? { riskReason: riskAssessment.reason } : {}),
                    }),
                }
              : {}),
          }
        )
        // Decision (or abort) received — lift the lead out of awaiting_approval
        // so neither answer surface keeps rendering a live-looking gate.
        deps.storeWriter.updateTeammate(lead.id, { status: "idle" })
        if (decision.outcome === "approve") {
          approved = true
          hooks.dispatchOnTeamPlanReady({
            teamId,
            runId,
            plan: planResult.planText,
          })
          break
        }
        feedback = decision.feedback
      }
      if (!approved) {
        return {
          runId: "",
          status: ac.signal.aborted ? "cancelled" : "failed",
          reason: ac.signal.aborted
            ? "Aborted during plan approval"
            : "Plan rejected after max revisions",
        }
      }
    }

    // ── Build per-run shared state (notifier hoisted above the pre-run gates) ──
    const concurrency = createConcurrencyController(team.config.maxConcurrentTeammates ?? 5)
    const modelPref = createModelPreferenceController({
      resolveCheapModel: cheapModelHintFromSettings,
    })
    const pool = createTeammatePool({ teammates: workers, teamId, runId })
    // ADR-0090 Phase 7: one budget authority per run tree. The governor owns
    // the root guard (same thresholds/escalations as before); dispatches draw
    // through `governor.allocate(childRunId)` so attempts and failures ledger
    // per child. `budget` stays the guard for existing consumers.
    const { createRunBudgetGovernor } = await import("@/lib/ai/agent/execution/run-budget-governor")
    const governor = createRunBudgetGovernor({
      runId,
      limit: team.config.tokenBudget ?? 0,
      onCritical: team.config.governancePolicy?.budget?.onCritical ?? "notify",
      notifier,
      concurrencyCtrl: concurrency,
      modelCtrl: modelPref,
    })
    const budget = governor.guard

    // ── Guarded rate-limit resume controller ──
    // On a teammate rate-limit failure, dispatch-teammate reports the cooldown
    // here; once it elapses (and the run is still alive) we post a single
    // guarded "continue" nudge into the team mailbox so the lead/member resumes
    // instead of stalling. Disposed in `finally`. Gated by config (default on).
    const nudgeCfg = team.config.nudges ?? {}
    const rateLimitResume =
      nudgeCfg.enabled !== false
        ? new RateLimitResumeController(
            createRealResumeDeps(
              ({ memberId, generation }) => {
                const member = workers.find((w) => w.id === memberId)
                notifier.notify({
                  level: "info",
                  title: `Resuming after rate-limit cooldown`,
                  body: `${member?.name ?? memberId} is being nudged to continue.`,
                  runId,
                  teamId,
                  dedupeKey: `nudge:${runId}:${memberId}:${generation}`,
                })
                deps.storeWriter.addMessage({
                  teamId,
                  senderId: "system",
                  recipientId: team.leadId || memberId,
                  type: "system",
                  content: NUDGE_CONTINUE_PROMPT,
                  structuredPayload: {
                    type: "nudge",
                    nudgeType: "rate_limit_resume",
                    generation,
                  },
                })
              },
              {
                maxPerHour: nudgeCfg.maxPerMemberPerHour,
                busyWindowMs: nudgeCfg.busySignalWindowMs,
              }
            )
          )
        : undefined

    // ── Wire HITL gate subscriptions ──
    const subs: Array<() => void> = []

    // Deadlock gate: open the HITL recovery modal, or — when the team disabled
    // `enableDeadlockRecovery` — fast-fail instead of hanging. See deadlock-gate.ts.
    subs.push(
      pool.onAllUnavailable(
        createDeadlockHandler({
          recovery: team.config.enableDeadlockRecovery !== false,
          behavior: gatePolicy.deadlock,
          runId,
          teamId,
          notifier,
          concurrency,
          pool,
          signal: ac.signal,
          abort: (err) => ac.abort(err),
        })
      )
    )

    // Per ADR-0022 §2.2 / §4.6. Non-blocking teammate-fix gate: the run
    // continues on the remaining teammates; the user can rejoin the
    // disqualified one (or skip permanently) via the modal.
    subs.push(
      pool.onTeammateDisqualified((teammateId, reason) => {
        if (ac.signal.aborted) return
        const tm = workers.find((w) => w.id === teammateId)
        if (gatePolicy.teammateFix !== "block") {
          // Headless: reject semantics are fail-open (leave disqualified, run
          // continues on the remaining workers) — inform, don't gate.
          notifier.notify({
            level: "info",
            title: `Teammate disqualified: ${tm?.name ?? teammateId}`,
            body: `Reason: ${reason}. Headless ${origin} run continues on the remaining teammates.`,
            runId,
            teamId,
            dedupeKey: `teammate-fix:${runId}:${teammateId}`,
          })
          return
        }
        notifier.notify({
          level: "critical",
          title: `Teammate disqualified: ${tm?.name ?? teammateId}`,
          body: `Reason: ${reason}. Fix configuration and rejoin, or skip.`,
          runId,
          teamId,
          openApproval: {
            scope: "agent-team-teammate-fix",
            id: `${runId}:${teammateId}`,
          },
          dedupeKey: `teammate-fix:${runId}:${teammateId}`,
        })
        void waitForDecision(
          { scope: "agent-team-teammate-fix", id: `${runId}:${teammateId}` },
          ac.signal
        )
          .then((decision) => {
            if (decision.outcome === "approve") {
              const action = (decision.plan as { action?: "rejoin" | "skip_permanently" })?.action
              if (action === "rejoin") pool.rejoin(teammateId)
            }
            // reject: leave disqualified; run keeps going on the rest.
          })
          .catch(() => {
            // signal aborted while waiting — no-op
          })
      })
    )

    // Wire budget threshold events to the plugin hooks pipeline. Plugins
    // listening on onTeamBudgetWarn see both warning and critical crossings
    // with `used` / `limit` snapshots so they can decide whether to nudge
    // model preference, post a dashboard, or veto further dispatch.
    subs.push(
      budget.on("warning_crossed", () => {
        const status = budget.status()
        hooks.dispatchOnTeamBudgetWarn({
          teamId,
          runId,
          level: "warning",
          used: status.used,
          limit: status.limit,
        })
      })
    )
    subs.push(
      budget.on("critical_crossed", () => {
        const status = budget.status()
        hooks.dispatchOnTeamBudgetWarn({
          teamId,
          runId,
          level: "critical",
          used: status.used,
          limit: status.limit,
        })
      })
    )

    let budgetResolverActive = false
    subs.push(
      budget.on("pause_for_review", () => {
        if (ac.signal.aborted || budgetResolverActive) return
        if (gatePolicy.budget !== "block") {
          // Headless: nobody can grant an extension — abort instead of
          // parking the run at concurrency 0 forever.
          ac.abort(new Error(`Token budget exhausted (headless ${origin} run)`))
          return
        }
        budgetResolverActive = true
        concurrency.reduceTo(0)
        void waitForDecision({ scope: "agent-team-budget", id: runId }, ac.signal)
          .then((decision) => {
            if (decision.outcome === "approve") {
              const extra = (decision.plan as { extraTokens?: number })?.extraTokens ?? 0
              if (extra > 0) budget.extendLimit(extra)
            } else {
              ac.abort(new Error("Operator declined budget extension"))
            }
          })
          .catch(() => {
            // signal aborted — no-op
          })
          .finally(() => {
            budgetResolverActive = false
          })
      })
    )

    // ── Employee Digital Twin runtime (ADR-0003 × ADR-0022) ──
    // Build the shared vector-store deps once per run when any teammate is
    // twin-bound OR the team exposes team-level knowledge twins OR the run may
    // recruit twins mid-run; enumerate recruitable twins only when adaptive
    // re-planning / the progress ledger can re-staff. Fully best-effort.
    const usesTwin =
      workers.some((w) => Boolean(w.config?.twinId)) ||
      (team.config.knowledgeTwinIds?.length ?? 0) > 0
    const mayRecruit =
      team.config.adaptiveReplan?.enabled === true || team.config.progressLedger?.enabled === true
    const { twinDeps, availableTwins } = await resolveTeamTwinRuntime({
      buildDeps: usesTwin || mayRecruit,
      listAvailable: mayRecruit,
    })
    // Once per run, after the twin deps so the memory backend can share their
    // vector-store client instead of opening a second one. See
    // `./team/memory-context`.
    const { resolveTeamMemoryRuntime } = await import("./team/memory-context")
    const memoryDeps = await resolveTeamMemoryRuntime(twinDeps)

    // ── Workspace isolation: one Registry/Bundle authority ──
    // A tool-capable local dispatch may only receive a Registry alias. Browser
    // text-only execution does not touch the filesystem and needs no controller.
    if (isoCfg?.enabled && isoCfg.reconcile && !["manual", "pipeline"].includes(isoCfg.reconcile)) {
      notifier.notify({
        level: "warn",
        title: "Workspace promotion requires review",
        body: `The ${isoCfg.reconcile} reconcile mode is not applied automatically to detached Registry environments. Review and promote the result explicitly.`,
        runId,
        teamId,
        dedupeKey: `wsiso-promotion:${runId}`,
      })
    }

    // PR feedback remains a promotion-only compatibility feature. Managed
    // environments are detached, so the runtime must not invent branches or
    // PR bindings before the user explicitly promotes one.
    if (team.config.prFeedback?.enabled && workspaceController) {
      notifier.notify({
        level: "warn",
        title: "PR feedback awaits branch promotion",
        body: "Detached Registry environments do not create pull-request branches automatically.",
        runId,
        teamId,
        dedupeKey: `prfeedback-promotion:${runId}`,
      })
    }

    // ── Register the per-run context FIRST ──
    // Ultracode planning + every pattern/dispatch node reads it via
    // getTeamRunContext(runId); registering before synthesis lets the planner
    // dispatch a teammate to author the pattern composition.
    registerTeamRunContext({
      runId,
      teamId,
      ...(deps.traceId ? { traceId: deps.traceId } : {}),
      team,
      pool,
      budget,
      governor,
      notifier,
      concurrency,
      modelPref,
      ...(durableEnvironment ? { durableEnvironment } : {}),
      gatePolicy,
      // Blocking task review (ADR-0071). Both only when review is enabled, so a
      // team without it carries no reviewer and the review node is never
      // emitted. `allMembers` (not `workers`) — the lead is excluded from
      // dispatch, which is exactly why it can review.
      ...(isTaskReviewEnabled(team.config)
        ? {
            ...(allMembers.find((m) => m.id === team.leadId)
              ? { lead: allMembers.find((m) => m.id === team.leadId)! }
              : {}),
            ...(deps.runLeadReview ? { runLeadReview: deps.runLeadReview } : {}),
          }
        : {}),
      // IM/workflow trigger origin — lets run-scoped consumers (e.g. the
      // team_post_to_chat collaboration tool) resolve the bound conversation.
      ...(deps.triggeredFrom ? { triggeredFrom: deps.triggeredFrom } : {}),
      ...(deps.parentPermissionCeiling
        ? { parentPermissionCeiling: deps.parentPermissionCeiling }
        : {}),
      storeWriter: deps.storeWriter,
      ...(rateLimitResume ? { rateLimitResume } : {}),
      ...(twinDeps ? { twinDeps } : {}),
      ...(memoryDeps ? { memoryDeps } : {}),
      ...(availableTwins.length > 0 ? { availableTwins } : {}),
      // Lazily populated by dispatchTeammate on first claim — see
      // `lib/ai/agent/team/dispatch-teammate.ts`.
      resolvedCapabilities: new Map(),
      // Lazily populated by resolveTeammateExternalAgent for external-backed
      // teammates — see `lib/ai/agent/team/resolve-external-backing.ts`.
      externalAgentInstances: new Map(),
      ...(workspaceController ? { workspaceController } : {}),
    })

    // ── Synthesize the VisualWorkflow (ultracode patterns vs. flat task DAG) ──
    // The per-wave path (synthesized inside `runTeamWaves`) is engaged by EITHER
    // adaptive re-planning OR the progress ledger — both need the between-wave
    // checkpoint hook, which the single-pass `runWorkflow` does not expose. So
    // enabling the progress ledger alone is sufficient (it does not silently
    // require `adaptiveReplan.enabled`).
    const adaptiveFlat =
      !ultracodeActive &&
      (team.config.adaptiveReplan?.enabled === true || team.config.progressLedger?.enabled === true)
    let workflow: VisualWorkflow | undefined
    if (ultracodeActive) {
      // Side-effect import registers the pattern.* node executors.
      await import("./team/patterns")
      const [{ planUltracodeWorkflow }, { synthesizeUltracodeWorkflow }] = await Promise.all([
        import("./team/ultracode-planner"),
        import("./team/synthesize-ultracode"),
      ])
      const teamCtx = getTeamRunContext(runId)!
      const plan = await planUltracodeWorkflow(teamCtx, { signal: ac.signal })
      ;({ workflow } = synthesizeUltracodeWorkflow({
        team,
        plan,
        initialConcurrency: concurrency.get(),
        wallClockTimeoutMs: team.config.defaultTimeout,
      }))
    } else if (!adaptiveFlat) {
      ;({ workflow } = synthesizeTeamWorkflow({
        team,
        tasks,
        initialConcurrency: concurrency.get(),
        wallClockTimeoutMs: team.config.defaultTimeout,
        ...(externallySatisfiedIds ? { satisfiedDependencyIds: externallySatisfiedIds } : {}),
      }))
    }

    // Run one synthesized workflow with the stable runId + trigger binding.
    // Reused per-wave by the adaptive path so every wave overwrites the same
    // run row (single-run view); the IM-origin binding flows onto each call.
    const runOneWorkflow = (wf: VisualWorkflow) =>
      runWorkflow({
        workflow: wf,
        trigger: {
          workflowId: wf.id,
          kind: "trigger.team",
          payload: { teamId },
          originAt: Date.now(),
          // Carry the IM origin onto the trigger binding too, so any
          // downstream node that inspects `ctx.trigger.binding` sees the
          // originating conversation (parity with `startWorkflowFromIM`).
          ...(deps.triggeredFrom?.adapterId && deps.triggeredFrom?.conversationKey
            ? {
                binding: {
                  adapterId: deps.triggeredFrom.adapterId,
                  conversationKey: deps.triggeredFrom.conversationKey,
                  ...(deps.triggeredFrom.sessionId
                    ? { sessionId: deps.triggeredFrom.sessionId }
                    : {}),
                },
              }
            : {}),
        },
        runId,
        signal: ac.signal,
        concurrency,
        // IM-origin fan-out: the progress-runner only mirrors runs whose
        // `triggeredBy.source === "im"`. Threading this is the single line
        // that lights up team → IM result delivery; UI/API runs omit it.
        ...(deps.triggeredFrom ? { triggeredBy: deps.triggeredFrom } : {}),
      })

    // Track final status so the finally block can fire onTeamComplete
    // with a meaningful payload even when runWorkflow throws.
    let finalStatus: RunTeamLifecycleResult["status"] = "failed"
    let finalReason: string | undefined
    let suppressCompletionFanout = false
    try {
      let result: Awaited<ReturnType<typeof runWorkflow>>
      if (adaptiveFlat) {
        const waveCtx = getTeamRunContext(runId)!
        // When the progress ledger is enabled, swap the lead-only re-plan
        // checkpoint for the ledger checkpoint (stall detection + autonomous
        // escalation). The ledger instance is created once so its cross-wave
        // stall state persists across waves.
        const ledgerCheckpoint =
          team.config.progressLedger?.enabled === true
            ? createLedgerCheckpoint({ ctx: waveCtx, signal: ac.signal })
            : undefined
        // Every wave reuses the same runId so the run row is overwritten in
        // place (single-run view), but the orchestrator's ownership guard
        // (ADR-0061 P4) short-circuits on a terminal row — wave N-1's
        // "succeeded" would silently skip every later wave. Re-open the row
        // between waves; a "cancelled" row is a companion soft-cancel and
        // must still kill the run, so it is honored, never resurrected.
        let executedWaves = 0
        const runWaveReentrant = async (wf: VisualWorkflow): Promise<RunWorkflowResult> => {
          if (executedWaves > 0) {
            const { getDb } = await import("@/lib/db/schema")
            const row = await getDb().workflowRuns.get(runId)
            if (row?.status === "cancelled") {
              return { runId, status: "cancelled" }
            }
            if (row && (row.status === "succeeded" || row.status === "failed")) {
              await getDb().workflowRuns.update(runId, { status: "running" })
            }
          }
          executedWaves += 1
          return runOneWorkflow(wf)
        }
        const waveRes = await runTeamWaves({
          teamCtx: waveCtx,
          tasks,
          initialConcurrency: concurrency.get(),
          ...(team.config.defaultTimeout ? { wallClockTimeoutMs: team.config.defaultTimeout } : {}),
          signal: ac.signal,
          runWave: runWaveReentrant,
          ...(ledgerCheckpoint ? { checkpoint: ledgerCheckpoint } : {}),
        })
        // A no-task run (or one with no executed wave) has no lastResult; the
        // wave status is authoritative.
        result = waveRes.lastResult ?? { runId, status: "succeeded" }
        finalStatus =
          waveRes.status === "succeeded"
            ? "completed"
            : waveRes.status === "cancelled"
              ? "cancelled"
              : "failed"
        finalReason = waveRes.error?.message ?? result.error?.message
      } else {
        result = await runOneWorkflow(workflow!)
        finalStatus =
          result.status === "succeeded"
            ? "completed"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed"
        finalReason = result.error?.message
        // Ultracode runs end on a single terminal `pattern.synthesize` node;
        // runWorkflow surfaces its output as `result.output`. Persist the report
        // to `team.finalResult` so the workspace surfaces the synthesized answer.
        if (ultracodeActive && finalStatus === "completed") {
          const report = (result.output as { report?: string } | undefined)?.report
          if (report && deps.storeWriter.setFinalResult) {
            deps.storeWriter.setFinalResult(teamId, report)
          }
        }
      }
      return {
        runId: result.runId,
        status: finalStatus,
        reason: finalReason,
        output: result.output,
        ...(deps.traceId ? { traceId: deps.traceId } : {}),
      }
    } catch (err) {
      finalReason = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      // The terminal execution-journal event is written for EVERY runtime
      // version. It used to be nested inside the `durable-v2` work, so a
      // legacy run's execution row stayed at `running` for good: nothing else
      // settles it, and `watch-squad-run.ts` waits on exactly this signal to
      // release the conversation.
      //
      // `legacy` is the DEFAULT (`DEFAULT_TEAM_CONFIG.runtimeVersion`), which
      // made this the common case rather than an edge one. A Squad made with
      // New Squad held its conversation in `streaming` forever, against
      // ADR-0140's "the conversation holds while the Squad works", and every
      // legacy run the manager now records sat in the cockpit as permanently
      // running with a Stop button that could not settle it.
      const abortMessage =
        ac.signal.reason instanceof Error
          ? ac.signal.reason.message
          : String(ac.signal.reason ?? "")
      let persistedStatus: import("@/types/agent/agent-team-runtime").AgentTeamRunStatus | undefined
      if (team.config.runtimeVersion === "durable-v2") {
        const { getAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
        persistedStatus = (await getAgentTeamRun(runId))?.status
        suppressCompletionFanout = persistedStatus === "needs_input"
      }
      // `paused` and `needs_input` are deliberately NOT terminal: a paused
      // Squad is still the conversation's turn and can be steered.
      const teamRunStatus =
        persistedStatus === "needs_input"
          ? "needs_input"
          : finalStatus === "cancelled" && abortMessage === "paused"
            ? "paused"
            : finalStatus === "cancelled" && abortMessage === "shutdown"
              ? "terminated"
              : finalStatus === "completed"
                ? "completed"
                : finalStatus === "cancelled"
                  ? "cancelled"
                  : "failed"
      if (team.config.runtimeVersion === "durable-v2") {
        const { updateAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
        await updateAgentTeamRun(runId, {
          status: teamRunStatus,
          ...(finalReason ? { recoveryReason: finalReason } : {}),
          ...(["completed", "cancelled", "failed", "terminated"].includes(teamRunStatus)
            ? { completedAt: Date.now() }
            : {}),
          updatedAt: Date.now(),
        }).catch(() => false)
      }
      const { getExecutionRun, runEventJournal } = await import("@/lib/db/execution-runs")
      const { agentTeamExecutionRunId } = await import("@/lib/execution/agent-team-bridge")
      const executionRunId = agentTeamExecutionRunId(runId)
      const executionRun = await getExecutionRun(executionRunId).catch(() => undefined)
      if (executionRun && !["completed", "failed", "cancelled"].includes(executionRun.status)) {
        const eventType =
          teamRunStatus === "completed"
            ? "run.completed"
            : teamRunStatus === "failed"
              ? "run.failed"
              : teamRunStatus === "cancelled" || teamRunStatus === "terminated"
                ? "run.cancelled"
                : teamRunStatus === "paused"
                  ? "run.paused"
                  : "run.waiting"
        await runEventJournal
          .append(executionRunId, {
            id: `execution-event:${runId}:team-terminal:${teamRunStatus}`,
            ts: Date.now(),
            type: eventType,
            visibility: "summary",
            payload: {
              summary:
                eventType === "run.waiting"
                  ? "Agent team run requires input"
                  : `Agent team run ${teamRunStatus}`,
            },
          })
          .catch(() => undefined)
      }
      if (!suppressCompletionFanout) {
        hooks.dispatchOnTeamComplete({
          teamId,
          runId,
          status: finalStatus,
          reason: finalReason,
        })
      }
      // "On team finished" workflow fan-out (trigger.team). Fire-and-forget:
      // the linkage module PII-gates reason/finalResult and enforces the
      // chain-depth loop guard. This terminal block is the single point every
      // start surface funnels through, so no per-trigger wiring is needed.
      if (!suppressCompletionFanout) {
        void import("./team-completion-linkage")
          .then(({ dispatchTeamCompletedTriggers }) =>
            dispatchTeamCompletedTriggers({
              teamId,
              teamName: team.name,
              runId,
              status: finalStatus,
              ...(finalReason ? { reason: finalReason } : {}),
              ...(() => {
                const finalResult = deps.storeReader.getTeam(teamId)?.finalResult
                return finalResult ? { finalResult } : {}
              })(),
              chainDepth: deps.triggerChainDepth ?? 0,
            })
          )
          .catch(() => {
            // Best-effort — fan-out failures must not affect the run result.
          })
      }
      for (const u of subs) {
        try {
          u()
        } catch {
          /* listener already gone */
        }
      }
      // Cancel any pending resume timer so it can't fire after the run ends.
      rateLimitResume?.dispose()
      unregisterTeamRunContext(runId)
      // Release any pending approval-bus waiters keyed to this run.
      approveBus({ scope: "agent-team-deadlock", id: runId })
      approveBus({ scope: "agent-team-budget", id: runId })
      approveBus({ scope: "agent-team-replan", id: runId })
      rejectBus({ scope: "agent-team-deadlock", id: runId })
      rejectBus({ scope: "agent-team-budget", id: runId })
      rejectBus({ scope: "agent-team-replan", id: runId })
      for (const w of workers) {
        rejectBus({ scope: "agent-team-teammate-fix", id: `${runId}:${w.id}` })
      }
    }
  } finally {
    inflightControllers.delete(teamId)
  }
}

/** Cancel a running team. Returns true if a controller was found + aborted. */
export function abortTeam(teamId: string, reason?: unknown): boolean {
  const ctrl = inflightControllers.get(teamId)
  if (!ctrl || ctrl.signal.aborted) return false
  ctrl.abort(reason ?? new Error("Aborted by caller"))
  return true
}

/** Test-only — drop in-flight entries without aborting. */
export function __resetInflightForTesting(): void {
  inflightControllers.clear()
}
