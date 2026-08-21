/**
 * Agent Team runtime dependencies — production wiring (F-path).
 *
 * Per ADR-0022 §3.9. Previously this module owned `runTeammateTask` (the
 * per-task LLM dispatcher). Under the F-path, dispatch happens inside the
 * `action.team.task.dispatch` workflow node executor; this module shrinks to
 * prompt builders + the lead-planning provider + a notifierDeps factory.
 *
 * Kept side-effect free at module scope so `__resetAgentTeamRuntimeForTesting`
 * + `configureAgentTeamRuntime` in tests can swap deps without leaking state.
 */

import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore, gateTypeFromScope } from "@/stores/agent/pending-gates-store"
import { executeAgent as defaultExecuteAgent } from "./agent-executor"
import {
  defaultLifecycleFirer,
  firePreCallHooks,
  firePostCallHooks,
  type AgentHookContext,
  type LifecycleHookFirer,
} from "@/lib/claude/hooks/lifecycle-firer"
import { parseProposedPlan } from "./agent-team-runtime"
import {
  buildLeadReviewPrompt,
  leadReviewVerdictSchema,
  LEAD_REVIEW_SYSTEM_PROMPT,
  type LeadReviewVerdict,
} from "./team/lead-review"
import type { LeadPlanResult, RunTeamLifecycleDeps } from "./agent-team-runtime"
import type { TeamNotifierDeps } from "./team/team-notifier"
import {
  createResolveOctokit,
  createResolveTeamRepo,
  createRunPrReview,
} from "./team/pr-feedback/resolvers"
import { buildLeadExecutionConfig, readAppSettings } from "./team/lead-execution"
import type { AppSettings } from "@cognia/agent-config-types"

/** Build the prompt sent to a teammate for a specific task. */
export function buildTeammatePrompt(
  team: AgentTeam,
  teammate: AgentTeammate,
  task: AgentTeamTask
): string {
  const role = teammate.description?.trim() || teammate.config?.specialization || "general teammate"
  const briefing = teammate.spawnPrompt?.trim()
    ? `\nSpecialty briefing from the lead:\n${teammate.spawnPrompt.trim()}\n`
    : ""
  const expected = task.expectedOutput?.trim()
    ? `\nExpected output:\n${task.expectedOutput.trim()}\n`
    : ""
  return [
    `You are ${teammate.name}, a teammate on the "${team.name}" team.`,
    `Your role: ${role}.${briefing}`,
    "",
    `Team goal:\n${team.task}`,
    "",
    `Your assigned task — "${task.title}":`,
    task.description,
    expected,
    "Produce the deliverable directly. Be concise, structured, and concrete.",
    "If you cannot complete the task, explain why in one short paragraph.",
  ].join("\n")
}

/** Build the planning prompt for the team lead. */
export function buildLeadPlanningPrompt(
  team: AgentTeam,
  workers: AgentTeammate[],
  feedback: string | undefined
): string {
  const roster =
    workers.length > 0
      ? workers
          .map(
            (w) => `- ${w.name}: ${w.description?.trim() || w.config?.specialization || "general"}`
          )
          .join("\n")
      : "- (none — propose hiring criteria instead)"
  const reviewer = feedback?.trim()
    ? `\nThe previous plan was rejected. Reviewer feedback:\n${feedback.trim()}\n\nRevise the plan accordingly.\n`
    : ""
  return [
    `You are ${team.name}'s lead.`,
    `Team goal:\n${team.task}`,
    "",
    `Available teammates (${workers.length}):`,
    roster,
    reviewer,
    "Produce a plan inside a single ```json fenced block with this shape:",
    "```json",
    "{",
    '  "summary": "one-sentence overview",',
    '  "steps": [',
    '    { "title": "...", "description": "...", "assignTo": "<teammate name or any>" }',
    "  ]",
    "}",
    "```",
    "Keep steps to 3–6 items. Each step should be actionable and self-contained.",
  ].join("\n")
}

const LEAD_SYSTEM_PROMPT =
  "You are a planning lead. Always respond with a single ```json fenced block matching the requested shape. Do not add prose around the block."

export interface BuildAgentTeamRuntimeDepsOptions {
  /** Override `executeAgent` for testing. */
  executeAgent?: typeof defaultExecuteAgent
  /** Optional notifierDeps override (defaults to silent — UI wires real channels). */
  notifierDeps?: TeamNotifierDeps
  /**
   * Lifecycle-hook firer bracketing the lead-planning LLM call (ADR-0040
   * follow-up): SessionStart / UserPromptSubmit / Stop / SessionEnd. Observable
   * for planning-spend tracking; pre-hook `additionalContext` is injected into
   * the planning system prompt. A blocking decision is advisory for planning
   * this round (logged, not enforced). Defaults to {@link defaultLifecycleFirer}.
   */
  firer?: LifecycleHookFirer
  /**
   * Read the app settings that decide which provider/model the lead runs on.
   * Defaults to the live settings store. `executeAgent` reads no store, so
   * without this the lead has no provider to resolve against at all.
   */
  readSettings?: () => Promise<AppSettings | null | undefined>
  /** Run-scoped IM persona injected only into the lead entry context. */
  entryPersona?: { id: string; name: string; systemPrompt: string }
}

/**
 * Build the runtime deps consumed by `agentTeamManager.start`.
 *
 * Returns `runLeadPlanning` (called by the synthesizer when
 * `team.config.requirePlanApproval` is true) and optional `notifierDeps`
 * (3-channel notifier wiring). storeReader/storeWriter are supplied by the
 * facade because they bind to the live Zustand store.
 */
export function buildAgentTeamRuntimeDeps(
  opts: BuildAgentTeamRuntimeDepsOptions = {}
): Pick<
  RunTeamLifecycleDeps,
  | "runLeadPlanning"
  | "runLeadReview"
  | "notifierDeps"
  | "resolveTeamRepo"
  | "resolvePrObserveOctokit"
  | "runPrReview"
> {
  const executeAgent = opts.executeAgent ?? defaultExecuteAgent
  const firer = opts.firer ?? defaultLifecycleFirer
  const readSettings = opts.readSettings ?? readAppSettings

  /**
   * Run one lead LLM turn: resolve the lead's provider/model, bracket the call
   * with lifecycle hooks, and return the raw text.
   *
   * Shared by planning and review so the two can never resolve onto different
   * providers. `phase` keeps them distinguishable to hook consumers (e.g.
   * planning-spend tracking), which is why it is threaded rather than hardcoded.
   */
  const runLeadTurn = async (params: {
    team: AgentTeam
    lead: AgentTeammate
    prompt: string
    systemPrompt: string
    phase: "planning" | "review"
    signal: AbortSignal
  }): Promise<string> => {
    const { team, lead, prompt, phase, signal } = params
    // Resolve BEFORE the pre-hooks fire: an unconfigured provider is a setup
    // error, not a turn that happened and failed, so it should not open a
    // hook bracket it will never close meaningfully.
    const execution = buildLeadExecutionConfig({ lead, settings: await readSettings() })

    const hookCtx: AgentHookContext = {
      agentId: `team-lead-${phase}`,
      // The lead planner is the team's own agent, so an `agents: "teammate"`
      // selector catches it alongside the dispatched teammates.
      agentKind: "teammate",
      agentRef: `team-lead-${phase}`,
      sessionId: team.id,
    }
    const pre = await firePreCallHooks(firer, hookCtx, prompt, {
      phase: `team-${phase}`,
      teamId: team.id,
    })
    const effectiveSystem = pre.additionalContext
      ? `${params.systemPrompt}\n\n${pre.additionalContext}`
      : params.systemPrompt

    try {
      const result = await executeAgent(prompt, {
        ...execution,
        systemPrompt: effectiveSystem,
        abortSignal: signal,
      })
      void firePostCallHooks(firer, hookCtx, { success: true })
      return result.text ?? ""
    } catch (err) {
      void firePostCallHooks(firer, hookCtx, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  const runLeadPlanning: NonNullable<RunTeamLifecycleDeps["runLeadPlanning"]> = async ({
    team,
    lead,
    feedback,
    signal,
  }): Promise<LeadPlanResult> => {
    const workers = useAgentTeamStore
      .getState()
      .getTeammates(team.id)
      .filter((m) => m.role === "teammate")
    const planText = await runLeadTurn({
      team,
      lead,
      prompt: buildLeadPlanningPrompt(team, workers, feedback),
      systemPrompt: [
        lead.config?.systemPrompt?.trim() ||
          team.config?.defaultSystemPrompt?.trim() ||
          LEAD_SYSTEM_PROMPT,
        opts.entryPersona?.systemPrompt.trim()
          ? `IM entry persona (${opts.entryPersona.name}):\n${opts.entryPersona.systemPrompt.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      phase: "planning",
      signal,
    })
    return { planText }
  }

  // Default notifierDeps route delivery through the Unified Notification Center
  // (ADR-0042): one `deliver` emit per event, lazy-loaded so the core (sonner /
  // Tauri / store) stays out of the SSR / node-test path unless used. The core
  // routes to center/toast/OS by level + user preferences. `log` (event-log)
  // and `openGate` (HITL modal) are unchanged. Tests override via
  // `opts.notifierDeps`.
  const defaultNotifierDeps: TeamNotifierDeps = {
    deliver: (p) => {
      void import("@/lib/notifications/runtime").then(({ notify }) =>
        notify({
          source: "agent-team",
          level: p.level === "warn" ? "warning" : p.level === "critical" ? "critical" : "info",
          title: p.title,
          body: p.body,
          href: p.detailHref,
          dedupeKey: p.dedupeKey,
          groupKey: p.runId,
          sourceRef: { kind: "team-run", id: p.runId },
          directed: p.level === "critical",
        })
      )
    },
    log: async (level, message, payload) => {
      if (level === "error") console.error("team:", message, payload)
      else if (level === "warn") console.warn("team:", message, payload)
      else console.info("team:", message, payload)
    },
    openGate: (gate) => {
      usePendingGatesStore.getState().open({
        key: gate.key,
        gateType: gateTypeFromScope(gate.key.scope),
        title: gate.title,
        body: gate.body,
        runId: gate.runId,
        teamId: gate.teamId,
        taskId: gate.taskId,
      })
    },
  }

  /**
   * Blocking task review (ADR-0071). Shares `runLeadTurn` with planning, so the
   * reviewer resolves onto the same provider the planner did — a lead that
   * planned on Opus and reviewed on something else would be two different
   * judgements wearing one name. No tools are passed: the lead reviews, and is
   * handed the diff rather than fetching it.
   */
  const runLeadReview: NonNullable<RunTeamLifecycleDeps["runLeadReview"]> = async ({
    team,
    lead,
    task,
    workerName,
    workerOutput,
    evidence,
    revision,
    previousFeedback,
    signal,
  }): Promise<LeadReviewVerdict> => {
    const text = await runLeadTurn({
      team,
      lead,
      prompt: buildLeadReviewPrompt({
        task,
        ...(workerName ? { workerName } : {}),
        workerOutput,
        evidence,
        revision,
        ...(previousFeedback ? { previousFeedback } : {}),
      }),
      // The reviewer's role overrides any persona the lead carries: a lead whose
      // systemPrompt says "you build features" must still review as a reviewer.
      systemPrompt: LEAD_REVIEW_SYSTEM_PROMPT,
      phase: "review",
      signal,
    })

    // Fail loudly on anything unreadable. Treating a malformed verdict as
    // approval would turn the gate into a rubber stamp exactly when the
    // reviewer is malfunctioning.
    const parsed = parseProposedPlan(text)
    if (!parsed.ok) {
      throw new Error(`runLeadReview: the lead's verdict was not valid JSON (${parsed.reason})`)
    }
    const verdict = leadReviewVerdictSchema.safeParse(parsed.plan)
    if (!verdict.success) {
      throw new Error(
        `runLeadReview: the lead did not return a usable verdict (${verdict.error.issues[0]?.message ?? "unparseable"})`
      )
    }
    return verdict.data
  }

  return {
    runLeadPlanning,
    runLeadReview,
    notifierDeps: opts.notifierDeps ?? defaultNotifierDeps,
    // PR feedback loop resolvers (ADR — team PR feedback). Fail-closed: each
    // returns null off-desktop / without creds, so the loop stays inert unless a
    // team enables `prFeedback` on a GitHub repo with resolvable credentials.
    resolveTeamRepo: createResolveTeamRepo(),
    resolvePrObserveOctokit: createResolveOctokit(),
    runPrReview: createRunPrReview(),
  }
}
