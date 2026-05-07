/**
 * Agent Team runtime dependencies — production wiring.
 *
 * `runTeamLifecycle` (in `agent-team-runtime.ts`) is pure orchestration.
 * It needs two callbacks injected at app startup:
 *
 *  - `runTeammateTask` — runs a single teammate against a single task and
 *    returns its result. Production builds here go through `executeAgent`
 *    (the same path plugins use); tests inject a mock.
 *  - `runLeadPlanning` — asks the lead to draft a plan; the runtime
 *    suspends on `plan-approval-bus` until the user approves or rejects.
 *
 * Both callbacks ALSO post status messages into the team's chat stream
 * (`addMessage`) so the workspace Chat tab fills during a run instead
 * of staying empty. The runtime does not post messages — it only writes
 * to task / teammate / event / report state.
 *
 * Kept side-effect free at module scope so `__resetAgentTeamRuntimeForTesting`
 * + `configureAgentTeamRuntime` in tests can swap deps without leaking
 * state between suites.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type {
  AgentTeam,
  AgentTeammate,
  AgentTeamTask,
  TeamMessageType,
} from "@/types/agent/agent-team"
import { executeAgent as defaultExecuteAgent } from "./agent-executor"
import type { AgentTeamRuntimeDeps, TeammateTaskResult, LeadPlanResult } from "./agent-team-runtime"

/** Truncate long LLM output before persisting it to the chat stream. */
const MAX_CHAT_RESULT_CHARS = 1200

function truncate(text: string, max: number = MAX_CHAT_RESULT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** Post a chat message via the live store — keeps senderName resolution in one place. */
function postMessage(params: {
  teamId: string
  senderId: string
  type: TeamMessageType
  content: string
  taskId?: string
}): void {
  useAgentTeamStore.getState().addMessage({
    teamId: params.teamId,
    senderId: params.senderId,
    type: params.type,
    content: params.content,
    taskId: params.taskId,
  })
}

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

const TEAMMATE_SYSTEM_PROMPT =
  "You are a focused, helpful agent teammate. Stay on-task and produce concrete output. Avoid filler."

const LEAD_SYSTEM_PROMPT =
  "You are a planning lead. Always respond with a single ```json fenced block matching the requested shape. Do not add prose around the block."

export interface BuildAgentTeamRuntimeDepsOptions {
  /** Override `executeAgent` for testing. */
  executeAgent?: typeof defaultExecuteAgent
}

/**
 * Build the runtime deps that `configureAgentTeamRuntime` consumes.
 * Splits prompt construction from message posting from LLM dispatch so
 * each piece is testable in isolation.
 */
export function buildAgentTeamRuntimeDeps(
  opts: BuildAgentTeamRuntimeDepsOptions = {}
): Pick<AgentTeamRuntimeDeps, "runTeammateTask" | "runLeadPlanning"> {
  const executeAgent = opts.executeAgent ?? defaultExecuteAgent

  const runTeammateTask: AgentTeamRuntimeDeps["runTeammateTask"] = async ({
    team,
    teammate,
    task,
    signal,
  }): Promise<TeammateTaskResult> => {
    postMessage({
      teamId: team.id,
      senderId: teammate.id,
      type: "broadcast",
      content: `Starting: ${task.title}`,
      taskId: task.id,
    })

    const prompt = buildTeammatePrompt(team, teammate, task)
    const systemPrompt =
      teammate.config?.systemPrompt?.trim() ||
      team.config?.defaultSystemPrompt?.trim() ||
      TEAMMATE_SYSTEM_PROMPT

    try {
      const result = await executeAgent(prompt, {
        systemPrompt,
        abortSignal: signal,
      })
      const text = result.text ?? ""
      postMessage({
        teamId: team.id,
        senderId: teammate.id,
        type: "result_share",
        content: truncate(text),
        taskId: task.id,
      })
      return { result: text }
    } catch (err) {
      const aborted = signal.aborted || isAbortError(err)
      const reason = err instanceof Error ? err.message : String(err)
      if (aborted) {
        postMessage({
          teamId: team.id,
          senderId: teammate.id,
          type: "shutdown",
          content: "Cancelled by operator",
          taskId: task.id,
        })
        throw err
      }
      postMessage({
        teamId: team.id,
        senderId: teammate.id,
        type: "system",
        content: `Task failed: ${reason}`,
        taskId: task.id,
      })
      return { result: "", error: reason }
    }
  }

  const runLeadPlanning: NonNullable<AgentTeamRuntimeDeps["runLeadPlanning"]> = async ({
    team,
    lead,
    feedback,
    signal,
  }): Promise<LeadPlanResult> => {
    postMessage({
      teamId: team.id,
      senderId: lead.id,
      type: "system",
      content: feedback?.trim() ? "Revising plan with reviewer feedback…" : "Drafting plan…",
    })

    const workers = useAgentTeamStore
      .getState()
      .getTeammates(team.id)
      .filter((m) => m.role === "teammate")
    const prompt = buildLeadPlanningPrompt(team, workers, feedback)
    const systemPrompt =
      lead.config?.systemPrompt?.trim() ||
      team.config?.defaultSystemPrompt?.trim() ||
      LEAD_SYSTEM_PROMPT

    try {
      const result = await executeAgent(prompt, {
        systemPrompt,
        abortSignal: signal,
      })
      const text = result.text ?? ""
      postMessage({
        teamId: team.id,
        senderId: lead.id,
        type: "plan_approval",
        content: text,
      })
      return { planText: text }
    } catch (err) {
      const aborted = signal.aborted || isAbortError(err)
      if (aborted) {
        postMessage({
          teamId: team.id,
          senderId: lead.id,
          type: "shutdown",
          content: "Planning cancelled by operator",
        })
        throw err
      }
      const reason = err instanceof Error ? err.message : String(err)
      postMessage({
        teamId: team.id,
        senderId: lead.id,
        type: "system",
        content: `Planning failed: ${reason}`,
      })
      throw err
    }
  }

  return { runTeammateTask, runLeadPlanning }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const name = (err as { name?: unknown }).name
  return name === "AbortError"
}
