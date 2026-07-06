/**
 * Executor dispatcher (the "analyze → orchestrate" glue).
 *
 * `planAutoOrchestration` already classifies an objective into a
 * `TeamRoutingAssessment.recommendedPattern`, but every caller funnels the
 * proposal into a materialized Agent Team regardless. `chooseExecutor` closes
 * that gap: it maps the assessment (plus an explicit operator consensus signal)
 * to a higher-level {@link ExecutorKind} — the actual thing that should run.
 *
 * Design: infer ABOVE `TeamExecutionPattern`, never widen it. Council and
 * ensemble are not team shapes (no roster/DAG/store team), and the pattern enum
 * is woven through exhaustive switches, `materialize`, and `isUltracodeActive`.
 * So this stays a pure mapping layer on top; the pattern enum is untouched.
 *
 * `assessRouting` cannot emit council/ensemble today (its LLM contract is
 * pattern-only), so those two are opt-in via {@link ConsensusSignal}. Runs
 * after `assessRouting`, reusing the computed assessment — it never calls a
 * model.
 */

import type {
  TeamDispatchDecision,
  TeamExecutionPattern,
  TeamExecutorKind,
  TeamRoutingAssessment,
} from "@/types/agent/agent-team"

/**
 * The concrete executor a proposal should run through. Canonical definition
 * lives in `types/agent/agent-team.ts` (so `AgentTeam.dispatchDecision` can
 * persist it without `types/` importing `lib/`); re-exported here under the
 * original names so existing imports keep working.
 */
export type ExecutorKind = TeamExecutorKind

/**
 * Operator-provided signals that opt into a consensus/verification executor.
 * These override the pattern-derived choice because `assessRouting` cannot
 * currently recommend council/ensemble on its own.
 */
export interface ConsensusSignal {
  /** Want cross-model agreement on one answer → council. */
  consensusNeeded?: boolean
  /** Want N-sample / adversarial verification of one answer → ensemble. */
  verificationNeeded?: boolean
}

export type DispatchDecision = TeamDispatchDecision

/** Map a `TeamExecutionPattern` to its executor kind (no consensus override). */
function patternToKind(pattern: TeamExecutionPattern): ExecutorKind {
  switch (pattern) {
    case "single_agent_recommended":
      return "single-send"
    case "ultracode_orchestration":
      return "team-ultracode"
    case "manager_worker":
    case "parallel_specialists":
      return "team-flat"
    case "background_handoff":
      return "background-handoff"
    case "external_handoff":
      return "external-handoff"
    default: {
      // Exhaustiveness guard — a new pattern must be mapped explicitly.
      const _never: never = pattern
      return "team-flat"
    }
  }
}

/**
 * Choose the executor for an assessed objective. Consensus/verify signals win
 * (they can't be inferred by the router); otherwise the recommended pattern
 * maps 1:1 to a kind.
 */
export function chooseExecutor(
  assessment: TeamRoutingAssessment,
  signal?: ConsensusSignal
): DispatchDecision {
  const pattern = assessment.recommendedPattern
  const base = { fromPattern: pattern, confidence: assessment.confidence }

  if (signal?.verificationNeeded) {
    return {
      ...base,
      kind: "ensemble",
      reason:
        "Operator requested verification — running an ensemble of samples with a synthesizer.",
    }
  }
  if (signal?.consensusNeeded) {
    return {
      ...base,
      kind: "council",
      reason: "Operator requested consensus — convening a council of models with a synthesizer.",
    }
  }
  return { ...base, kind: patternToKind(pattern), reason: assessment.reason }
}
