/**
 * Drains the online-evaluation queue.
 *
 * This is the half that makes the queue a queue rather than a growing table:
 * every claimed row leaves in a terminal state — `done`, `failed`, or `skipped`
 * with the reason — which is also the only state the retention sweep will
 * prune. A row that could never settle could never be deleted.
 *
 * Budget is reserved BEFORE a judge runs and settled after, on both the success
 * and failure paths. Deterministic evaluators are free and take no reservation;
 * sampling them would turn a fact into a sample statistic for no saving.
 */

import {
  decideJudgeSampling,
  type JudgeSamplingDecision,
  type OnlineEvalPolicyV1,
} from "@cognia/eval-core"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { queryByTrace } from "@/lib/db/agent-traces"
import {
  claimQueuedOnlineEvals,
  putObservations,
  readBudget,
  reserveOnlineEvalBudget,
  setOnlineEvalState,
  settleOnlineEvalBudget,
  skipOnlineEval,
} from "@/lib/db/eval-online"
import type { EvalOnlineQueueRow } from "@/lib/db/eval-online-types"
import { getCachedOnlineEvalPolicies } from "./policy-cache"
import { evaluateTraceDeterministically, traceToEvalInput } from "./evaluate-trace"

/** Worst-case USD charged against the cap before a judge call is allowed. */
export const JUDGE_COST_ESTIMATE_USD = 0.01

export interface OnlineEvalWorkerDependencies {
  claim: (limit: number) => Promise<EvalOnlineQueueRow[]>
  policies: () => readonly OnlineEvalPolicyV1[]
  loadSpans: (traceId: string) => Promise<AgentTraceSpan[]>
  writeObservations: typeof putObservations
  setState: typeof setOnlineEvalState
  skip: typeof skipOnlineEval
  reserve: typeof reserveOnlineEvalBudget
  settle: typeof settleOnlineEvalBudget
  budget: typeof readBudget
  now: () => number
  newId: (parts: string) => string
}

const defaultDependencies: OnlineEvalWorkerDependencies = {
  claim: claimQueuedOnlineEvals,
  policies: getCachedOnlineEvalPolicies,
  loadSpans: queryByTrace,
  writeObservations: putObservations,
  setState: setOnlineEvalState,
  skip: skipOnlineEval,
  reserve: reserveOnlineEvalBudget,
  settle: settleOnlineEvalBudget,
  budget: readBudget,
  now: () => Date.now(),
  newId: (parts) => `obs_${parts}`,
}

export interface OnlineEvalDrainResult {
  claimed: number
  evaluated: number
  skipped: number
  failed: number
  observations: number
  judgeDecisions: Record<string, number>
}

/**
 * Process up to `limit` queued items.
 *
 * A row whose policy version no longer exists is `skipped`, not retried: the
 * policy that asked the question has been edited or deleted, and answering it
 * under a different one would attribute a verdict to a version that never
 * requested it.
 */
export async function drainOnlineEvalQueue(
  limit = 20,
  dependencies: Partial<OnlineEvalWorkerDependencies> = {}
): Promise<OnlineEvalDrainResult> {
  const deps = { ...defaultDependencies, ...dependencies }
  const result: OnlineEvalDrainResult = {
    claimed: 0,
    evaluated: 0,
    skipped: 0,
    failed: 0,
    observations: 0,
    judgeDecisions: {},
  }

  const rows = await deps.claim(limit)
  result.claimed = rows.length
  if (rows.length === 0) return result

  const policies = deps.policies()
  for (const row of rows) {
    const policy = policies.find((candidate) => candidate.versionId === row.policyVersionId)
    if (!policy) {
      await deps.skip(row.id, "skipped-no-judge", deps.now())
      result.skipped += 1
      continue
    }

    try {
      await deps.setState(row.id, "running", { attempts: row.attempts + 1 }, deps.now())
      const spans = await deps.loadSpans(row.traceId)
      const now = deps.now()

      const deterministic = await evaluateTraceDeterministically({
        policy,
        traceId: row.traceId,
        spans,
        now,
        newId: (evaluatorId) => deps.newId(`${row.id}_${evaluatorId}`),
      })
      await deps.writeObservations(deterministic.observations)
      result.observations += deterministic.observations.length

      const decision = await runJudgeLeg(row, policy, spans, deps)
      result.judgeDecisions[decision] = (result.judgeDecisions[decision] ?? 0) + 1

      await deps.setState(row.id, "done", {}, deps.now())
      result.evaluated += 1
    } catch (error) {
      // A failure is terminal for this row rather than an endless retry: the
      // trace is not going to change, so the same evaluator will fail the same
      // way, and a row that never settles is a row that never gets pruned.
      await deps.setState(
        row.id,
        "failed",
        { error: error instanceof Error ? error.message : String(error) },
        deps.now()
      )
      result.failed += 1
    }
  }

  return result
}

/**
 * Decide — and record — whether this trace goes to a judge.
 *
 * The judge CALL is not implemented here; what is implemented is the control
 * around it, and it reports honestly. When sampling says run, the reservation
 * is taken and immediately released with zero spend, and the decision is
 * returned as `skipped-no-judge` unless a judge is actually configured. The
 * alternative — silently not sampling — is how a policy looks enabled while
 * doing nothing.
 */
async function runJudgeLeg(
  row: EvalOnlineQueueRow,
  policy: OnlineEvalPolicyV1,
  spans: readonly AgentTraceSpan[],
  deps: OnlineEvalWorkerDependencies
): Promise<JudgeSamplingDecision> {
  if (policy.judgeEvaluatorVersionIds.length === 0) return "skipped-no-judge"

  const prepared = traceToEvalInput(spans, row.traceId)
  if (!prepared) return "skipped-no-judge"

  const ledger = await deps.budget(policy.id, deps.now())
  const decision = decideJudgeSampling({
    policy,
    candidate: {
      traceId: row.traceId,
      ...(spans.some((span) => span.status === "error") ? { priority: true } : {}),
    },
    spentUsdToday: ledger.spentUsd + ledger.reservedUsd,
    judgedToday: ledger.judgedCount,
    estimatedUsd: JUDGE_COST_ESTIMATE_USD,
  })
  if (decision !== "run") return decision

  const reserved = await deps.reserve(
    policy.id,
    JUDGE_COST_ESTIMATE_USD,
    policy.budget.dailyUsdCap,
    deps.now()
  )
  // The ledger is the authority, not the pre-check: two workers can both pass
  // `decideJudgeSampling` and only one fit inside the cap.
  if (!reserved) return "skipped-budget"

  // Release without spending — the judge call itself lands with the rubric
  // evaluators. Charging nothing is the truth here, and the reservation must
  // not be leaked either way.
  await deps.settle(policy.id, JUDGE_COST_ESTIMATE_USD, 0, false, deps.now())
  return "skipped-no-judge"
}
