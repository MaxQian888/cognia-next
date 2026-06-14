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
import type { LeadPlanResult, RunTeamLifecycleDeps } from "./agent-team-runtime"
import type { TeamNotifierDeps } from "./team/team-notifier"

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
): Pick<RunTeamLifecycleDeps, "runLeadPlanning" | "notifierDeps"> {
  const executeAgent = opts.executeAgent ?? defaultExecuteAgent
  const firer = opts.firer ?? defaultLifecycleFirer

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
    const prompt = buildLeadPlanningPrompt(team, workers, feedback)
    const systemPrompt =
      lead.config?.systemPrompt?.trim() ||
      team.config?.defaultSystemPrompt?.trim() ||
      LEAD_SYSTEM_PROMPT

    // Bracket the planning LLM call with lifecycle hooks (ADR-0040 follow-up).
    // Observable for planning-spend tracking; pre-hook additionalContext is
    // injected into the planning system prompt (the "context loading" path).
    const hookCtx: AgentHookContext = { agentId: "team-lead-planning", sessionId: team.id }
    const pre = await firePreCallHooks(firer, hookCtx, prompt, {
      phase: "team-planning",
      teamId: team.id,
    })
    const effectiveSystem = pre.additionalContext
      ? `${systemPrompt}\n\n${pre.additionalContext}`
      : systemPrompt

    try {
      const result = await executeAgent(prompt, {
        systemPrompt: effectiveSystem,
        abortSignal: signal,
      })
      void firePostCallHooks(firer, hookCtx, { success: true })
      return { planText: result.text ?? "" }
    } catch (err) {
      void firePostCallHooks(firer, hookCtx, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
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

  return {
    runLeadPlanning,
    notifierDeps: opts.notifierDeps ?? defaultNotifierDeps,
  }
}
