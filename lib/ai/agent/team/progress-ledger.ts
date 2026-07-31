/**
 * Autonomous progress ledger (Magentic-One style). The existing
 * `replan-checkpoint` is the *task ledger* — the lead revising the plan between
 * waves. This module adds the missing *progress ledger*: a cheap deterministic
 * per-wave check for whether the team is actually advancing, plus (on sustained
 * stall) an LLM judgment that can escalate beyond a plain re-plan.
 *
 * Layer 1 (deterministic, every wave, no LLM): {@link assessProgressDeterministic}
 * compares a per-wave snapshot (completed-task count + total result chars) to the
 * prior wave and accumulates a stall counter — the signal the pool does NOT
 * provide (the pool tracks availability/failure-class, not progress).
 *
 * Layer 2 (LLM, only once the stall counter crosses the threshold):
 * {@link judgeProgress} — see below.
 */
import { z } from "zod"
import type { AgentTeamTask } from "@/types/agent/agent-team"
import type { TeamRunContext } from "./team-run-context"
import { readDependencyResults } from "./shared-memory-orchestrator"
import { dispatchStructured } from "./structured-dispatch"

export interface LedgerSnapshot {
  /** Number of tasks completed so far this run. */
  completedCount: number
  /** Total characters of all completed-task results on the blackboard. */
  outputChars: number
}

export interface ProgressAssessment {
  /** True when this wave neither completed a new task nor grew the output. */
  stalled: boolean
  /** Consecutive stalled waves, including this one (0 when progress was made). */
  stallCount: number
  /** Convenience inverse of `stalled` for the first wave / progress waves. */
  madeProgress: boolean
  /** One-line, surfaced in the activity panel. */
  reason: string
}

/**
 * Compare the current wave's snapshot against the previous one. Progress is "a
 * new completed task OR net-new output"; anything else is a stall and bumps the
 * counter. The first wave (no prior snapshot) is always treated as progress.
 */
export function assessProgressDeterministic(
  prev: LedgerSnapshot | undefined,
  curr: LedgerSnapshot,
  prevStallCount: number
): ProgressAssessment {
  if (!prev) {
    return { stalled: false, stallCount: 0, madeProgress: true, reason: "first wave (baseline)" }
  }
  const newCompleted = curr.completedCount - prev.completedCount
  const newOutput = curr.outputChars - prev.outputChars
  const madeProgress = newCompleted > 0 || newOutput > 0
  if (madeProgress) {
    return {
      stalled: false,
      stallCount: 0,
      madeProgress: true,
      reason: `progress: +${newCompleted} task(s), ${newOutput >= 0 ? "+" : ""}${newOutput} chars`,
    }
  }
  return {
    stalled: true,
    stallCount: prevStallCount + 1,
    madeProgress: false,
    reason: "stall: no new completed task or output this wave",
  }
}

/** The LLM judge's verdict on a stalled run. */
export const progressLedgerVerdictSchema = z.object({
  /** Whether the original objective already appears satisfied (stop early). */
  isSatisfied: z.boolean(),
  /** Whether the team is making meaningful progress at all. */
  isProgressing: z.boolean(),
  /** Whether the team appears stuck repeating itself. */
  isLooping: z.boolean(),
  /** One-line diagnosis, surfaced in the activity panel + notifier. */
  diagnosis: z.string().min(1),
  /**
   * How to break the stall. `continue`/`replan` fall through to the lead
   * re-plan checkpoint; `consensus`/`delegate` escalate autonomously (gated by
   * the team's `allowAutonomous*` flags).
   */
  recommendedAction: z.enum(["continue", "replan", "consensus", "delegate"]),
  /** Optional teammate id / task hint for delegate/consensus targeting. */
  target: z.string().optional(),
})

export type ProgressLedgerVerdict = z.infer<typeof progressLedgerVerdictSchema>

/** Schema hint appended to the judge prompt for the model. */
export const PROGRESS_LEDGER_SCHEMA_HINT = [
  '{ "isSatisfied": boolean,',
  '  "isProgressing": boolean,',
  '  "isLooping": boolean,',
  '  "diagnosis": string,',
  '  "recommendedAction": "continue" | "replan" | "consensus" | "delegate",',
  '  "target"?: string }',
].join("\n")

/** Deterministic fail-open verdict: defer to the lead re-plan, never escalate. */
function failOpenVerdict(diagnosis: string): ProgressLedgerVerdict {
  return {
    isSatisfied: false,
    isProgressing: false,
    isLooping: false,
    diagnosis,
    recommendedAction: "replan",
  }
}

export interface JudgeProgressDeps {
  teamCtx: TeamRunContext
  /** Every task completed so far this run (for the accumulated-results view). */
  doneTaskIds: string[]
  /** The remaining planned tasks. */
  remaining: AgentTeamTask[]
  /** Consecutive stalled waves that triggered this judgment. */
  stallCount: number
  signal?: AbortSignal
  /** Injectable for tests; defaults to a `dispatchStructured` lead call. */
  dispatch?: (input: {
    teamCtx: TeamRunContext
    prompt: string
    signal?: AbortSignal
  }) => Promise<ProgressLedgerVerdict>
}

function buildJudgePrompt(deps: JudgeProgressDeps): string {
  const { teamCtx, doneTaskIds, remaining, stallCount } = deps
  const objective = teamCtx.team.task ?? teamCtx.team.description ?? teamCtx.team.name
  const results = readDependencyResults(teamCtx.teamId, doneTaskIds)
  const resultLines =
    results.length > 0
      ? results.map((r) => `- ${r.taskTitle ?? r.taskId}: ${r.value.slice(0, 400)}`).join("\n")
      : "(no captured output)"
  const remainingLines =
    remaining.length > 0
      ? remaining.map((t) => `- [${t.id}] ${t.title}: ${t.description}`).join("\n")
      : "(none)"
  return [
    `You are the progress monitor for the agent team "${teamCtx.team.name}".`,
    `Objective: ${objective}`,
    `The team has stalled for ${stallCount} consecutive wave(s) — no new completed tasks or output.`,
    "",
    "Completed-task results so far:",
    resultLines,
    "",
    "Remaining planned tasks:",
    remainingLines,
    "",
    "Diagnose the stall and recommend exactly one action:",
    '- "continue": the stall is benign; keep the current plan.',
    '- "replan": the lead should revise the remaining tasks.',
    '- "consensus": the team disagrees; open a vote to settle direction.',
    '- "delegate": hand a blocking sub-problem to a fresh background agent.',
    "Set isSatisfied=true only if the objective is already met.",
  ].join("\n")
}

/**
 * Ask the lead to diagnose a sustained stall and recommend how to break it.
 * Fail-open: any dispatch failure resolves to a non-escalating "replan" verdict
 * so an LLM hiccup never autonomously opens a consensus / delegation.
 */
export async function judgeProgress(deps: JudgeProgressDeps): Promise<ProgressLedgerVerdict> {
  const dispatch =
    deps.dispatch ??
    (async ({ teamCtx, prompt, signal }) => {
      const r = await dispatchStructured(
        teamCtx,
        { taskId: `progress-ledger:${teamCtx.runId}`, prompt, ...(signal ? { signal } : {}) },
        progressLedgerVerdictSchema,
        { schemaHint: PROGRESS_LEDGER_SCHEMA_HINT }
      )
      return r.value
    })

  try {
    return await dispatch({
      teamCtx: deps.teamCtx,
      prompt: buildJudgePrompt(deps),
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
  } catch {
    return failOpenVerdict("Progress judge unavailable — deferring to lead re-plan.")
  }
}
