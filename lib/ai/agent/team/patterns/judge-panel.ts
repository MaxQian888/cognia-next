/**
 * `pattern.judge-panel` — generate N independent attempts from different angles
 * (e.g. MVP-first, risk-first, user-first), score each with a panel of
 * independent judges, and surface the winner plus the full ranking. Beats
 * one-attempt-iterated when the solution space is wide.
 */

import { registerNodeExecutor, type NodeExecutorRegistration } from "@/lib/workflow/nodes/registry"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  attemptSchema,
  judgeScoreSchema,
  type Attempt,
  type JudgePanelParams,
  type JudgeScore,
} from "@/types/agent/ultracode"
import { dispatchStructured } from "../structured-dispatch"
import { fanoutLimit, getTeamCtxOrThrow, mapSettled, nonRetryable } from "./_shared"

const ATTEMPT_HINT = '{ "angle": "…", "content": "…" }'
const SCORE_HINT = '{ "score": 0-10, "rationale": "…" }'

export const JUDGE_PANEL_KIND = "pattern.judge-panel" as const

export interface RankedAttempt {
  attempt: Attempt
  scores: JudgeScore[]
  avgScore: number
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

async function execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const teamCtx = getTeamCtxOrThrow(ctx)
  const params = ctx.params as Partial<JudgePanelParams>
  const objective = params.objective?.trim()
  const angles = (params.angles ?? []).map((a) => a?.trim()).filter((a): a is string => !!a)
  const judgesPerAttempt = Math.max(1, Math.floor(params.judgesPerAttempt ?? 3))
  if (!objective) throw nonRetryable("pattern.judge-panel requires 'objective'")
  if (angles.length === 0)
    throw nonRetryable("pattern.judge-panel requires at least one 'angles' entry")

  ctx.log("info", `judge-panel: ${angles.length} attempts × ${judgesPerAttempt} judges`)

  // Phase 1 — produce one attempt per angle, in parallel.
  const attemptResults = await mapSettled(
    angles,
    fanoutLimit(teamCtx),
    async (angle, i) => {
      const r = await dispatchStructured(
        teamCtx,
        {
          taskId: `${ctx.stepId}:attempt:${i}`,
          prompt:
            `Objective: ${objective}\n\nApproach this from the angle: ${angle}\n\n` +
            "Produce your best concrete attempt at the objective from THIS angle only.",
          signal: ctx.signal,
        },
        attemptSchema,
        { schemaHint: ATTEMPT_HINT }
      )
      return r.value
    },
    (err, angle, i) => ctx.log("warn", `attempt ${i} (${angle}) failed: ${String(err)}`)
  )
  const attempts = attemptResults.filter((a): a is Attempt => a !== null)
  if (attempts.length === 0) {
    throw nonRetryable("pattern.judge-panel: every attempt failed to produce output")
  }

  // Phase 2 — every judge scores every attempt, all under one concurrency bound.
  const jobs = attempts.flatMap((attempt, ai) =>
    Array.from({ length: judgesPerAttempt }, (_, ji) => ({ attempt, ai, ji }))
  )
  const scoreResults = await mapSettled(
    jobs,
    fanoutLimit(teamCtx),
    async (job, idx) => {
      const r = await dispatchStructured(
        teamCtx,
        {
          taskId: `${ctx.stepId}:judge:${job.ai}:${job.ji}`,
          prompt:
            `Objective: ${objective}\n\nScore this attempt (0–10) on how well it meets the objective. ` +
            `Be a demanding, independent judge.\n\nAttempt (angle: ${job.attempt.angle}):\n${job.attempt.content}`,
          signal: ctx.signal,
        },
        judgeScoreSchema,
        { schemaHint: SCORE_HINT }
      )
      return { ai: job.ai, score: r.value }
    },
    (err, job, idx) =>
      ctx.log("warn", `judge job ${idx} (attempt ${job.ai}) failed: ${String(err)}`)
  )

  const scoresByAttempt = new Map<number, JudgeScore[]>()
  for (const res of scoreResults) {
    if (!res) continue
    const list = scoresByAttempt.get(res.ai) ?? []
    list.push(res.score)
    scoresByAttempt.set(res.ai, list)
  }

  const ranked: RankedAttempt[] = attempts
    .map((attempt, ai) => {
      const scores = scoresByAttempt.get(ai) ?? []
      return { attempt, scores, avgScore: average(scores.map((s) => s.score)) }
    })
    .sort((a, b) => b.avgScore - a.avgScore)

  const winner = ranked[0]
  ctx.log(
    "info",
    `judge-panel complete: winner "${winner.attempt.angle}" @ ${winner.avgScore.toFixed(2)}`
  )

  return { output: { winner, ranked, attempts } }
}

export const judgePanelNode: NodeExecutorRegistration = {
  kind: JUDGE_PANEL_KIND,
  typeVersion: 1,
  retryable: false,
  execute,
}

registerNodeExecutor(judgePanelNode)
