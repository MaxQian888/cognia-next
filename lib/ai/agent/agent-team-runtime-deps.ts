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
import { executeAgent as defaultExecuteAgent } from "./agent-executor"
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

    const result = await executeAgent(prompt, { systemPrompt, abortSignal: signal })
    return { planText: result.text ?? "" }
  }

  return {
    runLeadPlanning,
    ...(opts.notifierDeps ? { notifierDeps: opts.notifierDeps } : {}),
  }
}
