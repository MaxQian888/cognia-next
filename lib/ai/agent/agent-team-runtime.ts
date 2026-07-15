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
import { createTeammatePool } from "./team/teammate-pool"
import { resolveTeamTwinRuntime } from "./team/twin-context"
import { createBudgetGuard } from "./team/budget-guard"
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
  storeReader: {
    getTeam(teamId: string): AgentTeam | undefined
    getTeammates(teamId: string): AgentTeammate[]
    getTeamTasks(teamId: string): AgentTeamTask[]
  }
  storeWriter: TeamStoreWriter
  /** Only called when team.config.requirePlanApproval is true. */
  runLeadPlanning?: (params: {
    team: AgentTeam
    lead: AgentTeammate
    feedback?: string
    signal: AbortSignal
  }) => Promise<LeadPlanResult>
  /** Wired by buildAgentTeamRuntimeDeps in production. */
  notifierDeps?: TeamNotifierDeps
  /**
   * Origin of this team run when it was triggered from an IM channel
   * (e.g. an `action.team.run` node inside a workflow that
   * `startWorkflowFromIM` kicked off). Threaded onto the synthesized team
   * `runWorkflow` as `triggeredBy` so the existing
   * `workflow-progress-runner` fans the team's progress + final result back
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
    const team = deps.storeReader.getTeam(teamId)
    if (!team) {
      return { runId: "", status: "failed", reason: `Team ${teamId} not found` }
    }
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
    const runId = `run_team_${nanoid(12)}`
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
    const origin: TeamRunOrigin =
      deps.origin ?? (deps.triggeredFrom?.source === "im" ? "im" : "interactive")
    const gatePolicy = resolveGatePolicy(origin)

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
    const requirePlanApproval = Boolean(team.config.requirePlanApproval) || riskRaisedGate
    // Only explain the gate by its risk when risk is the SOLE cause. An
    // operator who set `requirePlanApproval` already knows why the gate is
    // there; telling them it's the risk assessment would be a lie.
    const gateIsRiskOnly = riskRaisedGate && !team.config.requirePlanApproval

    // ── Plan-approval gate (synthesizer-local; never enters workflow) ──
    if (requirePlanApproval) {
      // Headless: fail fast BEFORE running lead planning — approval without a
      // human is meaningless and planning tokens would be wasted on a run
      // that cannot be approved. Whether the gate was an explicit operator
      // choice or risk-raised, honor it by failing loudly instead of
      // auto-approving; a risky unattended run is exactly what this refuses.
      if (gatePolicy.planApproval !== "block") {
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
        const planResult = await deps.runLeadPlanning({
          team,
          lead,
          feedback,
          signal: ac.signal,
        })
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
        const decision = await waitForDecision(
          { scope: "agent-team", id: teamId },
          ac.signal
        ).catch(() => ({ outcome: "reject" as const, feedback: "aborted" }))
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
    const modelPref = createModelPreferenceController()
    const pool = createTeammatePool({ teammates: workers, teamId, runId })
    const budget = createBudgetGuard({
      runId,
      limit: team.config.tokenBudget ?? 0,
      onCritical: team.config.governancePolicy?.budget?.onCritical ?? "notify",
      notifier,
      concurrencyCtrl: concurrency,
      modelCtrl: modelPref,
    })

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

    // ── Workspace isolation: build the per-dispatch worktree allocator ──
    // Only when enabled + on desktop + the workingDir is a git repo. Otherwise
    // every teammate runs in the shared workingDir (today's behavior). Enabled
    // but unusable (web / non-git) warns once and runs unisolated.
    const isoCfg = team.config.workspaceIsolation
    let workspaceAllocator: import("./team/workspace/allocator").AgentWorkspaceAllocator | undefined
    let workspaceLedger:
      Map<string, import("./team/workspace/reconciler").ReconcileCandidate> | undefined
    let workspaceReconcile:
      | {
          mode: import("./team/workspace/reconciler").ReconcileMode
          selectStrategy?: import("./team/workspace/reconciler").SelectStrategy
          retain?: "all" | "keep-winner" | "prune-losers"
        }
      | undefined
    if (isoCfg?.enabled && team.config.workingDir) {
      const { isTauri } = await import("@/lib/tauri")
      const { gitIsRepo, gitWorktreeList } = await import("@/lib/git/commands")
      if (isTauri() && (await gitIsRepo(team.config.workingDir).catch(() => false))) {
        const wts = await gitWorktreeList(team.config.workingDir).catch(() => [])
        const baseRef = isoCfg.baseRef ?? wts.find((w) => w.isMain)?.head ?? undefined
        const { AgentWorkspaceAllocator } = await import("./team/workspace/allocator")
        workspaceAllocator = new AgentWorkspaceAllocator({
          mainRepo: team.config.workingDir,
          ...(baseRef ? { baseRef } : {}),
        })
        workspaceLedger = new Map()
        workspaceReconcile = {
          mode: isoCfg.reconcile ?? "manual",
          ...(isoCfg.selectStrategy ? { selectStrategy: isoCfg.selectStrategy } : {}),
          ...(isoCfg.retain ? { retain: isoCfg.retain } : {}),
        }
      } else {
        notifier.notify({
          level: "warn",
          title: "Workspace isolation unavailable",
          body: "Per-agent git isolation needs the desktop app and a git repository as the team's working directory. Running without isolation.",
          runId,
          teamId,
          dedupeKey: `wsiso-unavailable:${runId}`,
        })
      }
    }

    // ── PR feedback loop (ADR — team PR feedback) ──
    // Built when enabled + isolation active + a GitHub repo/creds resolve. It
    // observes each teammate's PR post-DAG (see the track+settle after
    // reconcile) and is disposed in the run's `finally`. Inert otherwise.
    let teamPrFeedback: import("./team/pr-feedback/runtime").TeamPrFeedback | undefined
    if (
      team.config.prFeedback?.enabled &&
      workspaceAllocator &&
      team.config.workingDir &&
      deps.resolveTeamRepo &&
      deps.resolvePrObserveOctokit
    ) {
      teamPrFeedback = await buildRunPrFeedback({
        runId,
        teamId,
        config: team.config.prFeedback,
        workingDir: team.config.workingDir,
        ...(team.leadId ? { leadId: team.leadId } : {}),
        ...(team.config.nudges ? { nudges: team.config.nudges } : {}),
        teammates: workers.map((w) => ({ id: w.id, name: w.name })),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title })),
        resolveTeamRepo: deps.resolveTeamRepo,
        resolvePrObserveOctokit: deps.resolvePrObserveOctokit,
        ...(deps.runPrReview ? { runPrReview: deps.runPrReview } : {}),
        notify: (n) =>
          notifier.notify({
            level: n.level,
            title: n.title,
            body: n.body,
            runId: n.runId,
            teamId: n.teamId,
            dedupeKey: n.dedupeKey,
          }),
        addMessage: (m) => deps.storeWriter.addMessage(m),
        onWarn: (message) =>
          notifier.notify({
            level: "warn",
            title: "PR feedback unavailable",
            body: message,
            runId,
            teamId,
            dedupeKey: `prfeedback-init:${runId}`,
          }),
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
      notifier,
      concurrency,
      modelPref,
      gatePolicy,
      // IM/workflow trigger origin — lets run-scoped consumers (e.g. the
      // team_post_to_chat collaboration tool) resolve the bound conversation.
      ...(deps.triggeredFrom ? { triggeredFrom: deps.triggeredFrom } : {}),
      storeWriter: deps.storeWriter,
      ...(rateLimitResume ? { rateLimitResume } : {}),
      ...(twinDeps ? { twinDeps } : {}),
      ...(availableTwins.length > 0 ? { availableTwins } : {}),
      // Lazily populated by dispatchTeammate on first claim — see
      // `lib/ai/agent/team/dispatch-teammate.ts`.
      resolvedCapabilities: new Map(),
      // Lazily populated by resolveTeammateExternalAgent for external-backed
      // teammates — see `lib/ai/agent/team/resolve-external-backing.ts`.
      externalAgentInstances: new Map(),
      // Workspace isolation (undefined unless enabled + desktop + git repo).
      ...(workspaceAllocator ? { workspaceAllocator } : {}),
      ...(workspaceLedger ? { workspaceLedger } : {}),
      ...(workspaceReconcile ? { workspaceIsolation: workspaceReconcile } : {}),
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
      // Workspace isolation: reconcile the per-dispatch agent branches now the
      // run has settled. Only on a clean completion — a failed/cancelled run
      // leaves its branches untouched for inspection. Best-effort: reconcile
      // never fails the run (the `finally` still reclaims the worktree dirs).
      if (
        finalStatus === "completed" &&
        workspaceAllocator &&
        workspaceLedger &&
        workspaceReconcile
      ) {
        try {
          const { reconcile } = await import("./team/workspace/reconciler")
          const strategy = workspaceReconcile.selectStrategy
          const judge =
            strategy === "judge"
              ? async (
                  cands: import("./team/workspace/reconciler").ReconcileCandidate[]
                ): Promise<string | null> => {
                  const [{ selectWinnerByJudge }, { executeAgent }] = await Promise.all([
                    import("./team/workspace/judge"),
                    import("./agent-executor"),
                  ])
                  return selectWinnerByJudge(cands, {
                    run: async (prompt) => (await executeAgent(prompt, {})).text ?? "",
                  })
                }
              : undefined
          const recResult = await reconcile(workspaceAllocator, [...workspaceLedger.values()], {
            runId,
            mode: workspaceReconcile.mode,
            ...(strategy ? { selectStrategy: strategy } : {}),
            ...(workspaceReconcile.retain ? { retain: workspaceReconcile.retain } : {}),
            ...(judge ? { judge } : {}),
          })
          deps.storeWriter.addEvent?.({
            type: "progress_update",
            teamId,
            data: { kind: "workspace_reconcile", ...recResult },
            timestamp: new Date(),
          })
        } catch (err) {
          notifier.notify({
            level: "warn",
            title: "Workspace reconcile failed",
            body: err instanceof Error ? err.message : String(err),
            runId,
            teamId,
            dedupeKey: `wsiso-reconcile:${runId}`,
          })
        }
      }
      // PR feedback: bind each teammate's committed branch to its PR and observe
      // for the bounded window (0 = one pass). Nudges route back via the team
      // mailbox; the loop is disposed in `finally`. Best-effort — never fails the
      // run.
      if (teamPrFeedback && workspaceAllocator) {
        try {
          await teamPrFeedback.trackAll(workspaceAllocator.allocated())
          await teamPrFeedback.settle(team.config.prFeedback?.observeWindowMs ?? 0)
        } catch (err) {
          notifier.notify({
            level: "warn",
            title: "PR feedback loop error",
            body: err instanceof Error ? err.message : String(err),
            runId,
            teamId,
            dedupeKey: `prfeedback-run:${runId}`,
          })
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
      hooks.dispatchOnTeamComplete({
        teamId,
        runId,
        status: finalStatus,
        reason: finalReason,
      })
      // "On team finished" workflow fan-out (trigger.team). Fire-and-forget:
      // the linkage module PII-gates reason/finalResult and enforces the
      // chain-depth loop guard. This terminal block is the single point every
      // start surface funnels through, so no per-trigger wiring is needed.
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
      for (const u of subs) {
        try {
          u()
        } catch {
          /* listener already gone */
        }
      }
      // Cancel any pending resume timer so it can't fire after the run ends.
      rateLimitResume?.dispose()
      // Stop the PR feedback loop so no scheduled poll fires after the run ends.
      teamPrFeedback?.dispose()
      // Workspace isolation: reclaim every worktree DIRECTORY (agent work is
      // already committed to its branch, which persists). Branch deletion is
      // reconcile's job (loser pruning), so keep branches here. Runs on every
      // exit path (success / failure / cancel) so worktrees never leak.
      if (workspaceAllocator) {
        await workspaceAllocator.gc({ deleteBranches: false }).catch(() => undefined)
      }
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
