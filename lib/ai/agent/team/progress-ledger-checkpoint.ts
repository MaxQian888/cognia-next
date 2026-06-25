/**
 * Progress-ledger checkpoint — a drop-in replacement for `runReplanCheckpoint`
 * passed as the wave runner's between-wave `checkpoint` when
 * `team.config.progressLedger.enabled`. It wraps the lead re-plan with a
 * Magentic-One-style progress ledger:
 *
 *  1. Deterministic (every wave, no LLM): snapshot completed-task count + total
 *     result chars, compare to the prior wave, accumulate a stall counter, and
 *     emit a `progress_update` event for the activity panel.
 *  2. While progressing — or stalled but under the threshold — defer to the
 *     normal lead `runReplanCheckpoint` (behavior unchanged).
 *  3. Once stalled past `stallThreshold`, an LLM judge diagnoses the run and may
 *     escalate beyond a plain re-plan: finish early (objective satisfied), open
 *     a consensus, or delegate — the latter two only when the matching
 *     `allowAutonomous*` flag is set. After any intervention the stall counter
 *     resets and the lead re-plan still runs to apply plan changes.
 *
 * Fail-open throughout: the judge already fails open to "replan"; a disallowed
 * escalation simply falls through to the lead re-plan.
 */
import type { AgentTeamTask } from "@/types/agent/agent-team"
import type { TeamRunContext } from "./team-run-context"
import { runReplanCheckpoint, type ReplanCheckpointOutcome } from "./replan-checkpoint"
import { continueDecision } from "./replan-schema"
import { readDependencyResults } from "./shared-memory-orchestrator"
import { createConsensus } from "./consensus-orchestrator"
import { delegateToBackground } from "./delegation-orchestrator"
import { assessProgressDeterministic, judgeProgress, type LedgerSnapshot } from "./progress-ledger"

export interface LedgerCheckpointInput {
  justRanTaskIds: string[]
  remaining: AgentTeamTask[]
}

export interface CreateLedgerCheckpointDeps {
  ctx: TeamRunContext
  signal?: AbortSignal
  /** Injectable lead re-plan (defaults to `runReplanCheckpoint`). */
  replan?: (input: LedgerCheckpointInput) => Promise<ReplanCheckpointOutcome>
  /** Injectable progress judge (defaults to `judgeProgress`). */
  judge?: typeof judgeProgress
  /** Injectable consensus opener (defaults to `createConsensus`). */
  consensus?: typeof createConsensus
  /** Injectable delegation (defaults to `delegateToBackground`). */
  delegate?: typeof delegateToBackground
}

export function createLedgerCheckpoint(
  deps: CreateLedgerCheckpointDeps
): (input: LedgerCheckpointInput) => Promise<ReplanCheckpointOutcome> {
  const { ctx } = deps
  const cfg = ctx.team.config.progressLedger ?? {}
  const threshold = cfg.stallThreshold ?? 2

  const replan =
    deps.replan ??
    ((input: LedgerCheckpointInput) =>
      runReplanCheckpoint({
        teamCtx: ctx,
        runId: ctx.runId,
        justRanTaskIds: input.justRanTaskIds,
        remaining: input.remaining,
        ...(deps.signal ? { signal: deps.signal } : {}),
      }))
  const judge = deps.judge ?? judgeProgress
  const openConsensus = deps.consensus ?? createConsensus
  const delegate = deps.delegate ?? delegateToBackground

  const doneIds = new Set<string>()
  let prevSnapshot: LedgerSnapshot | undefined
  let stallCount = 0

  return async (input) => {
    for (const id of input.justRanTaskIds) doneIds.add(id)

    // ── 1. Deterministic snapshot + stall assessment ──
    const results = readDependencyResults(ctx.teamId, [...doneIds])
    const outputChars = results.reduce((sum, r) => sum + r.value.length, 0)
    const snapshot: LedgerSnapshot = { completedCount: doneIds.size, outputChars }
    const assessment = assessProgressDeterministic(prevSnapshot, snapshot, stallCount)
    prevSnapshot = snapshot
    stallCount = assessment.stallCount

    ctx.storeWriter.addEvent?.({
      type: "progress_update",
      teamId: ctx.teamId,
      timestamp: new Date(),
      data: {
        source: "progress-ledger",
        completedCount: snapshot.completedCount,
        remaining: input.remaining.length,
        stallCount,
        stalled: assessment.stalled,
        reason: assessment.reason,
      },
    })

    // ── 2. Progressing, or stalled under threshold → normal lead re-plan ──
    if (!assessment.stalled || stallCount < threshold) {
      return replan(input)
    }

    // ── 3. Sustained stall → LLM judge + (gated) autonomous escalation ──
    const verdict = await judge({
      teamCtx: ctx,
      doneTaskIds: [...doneIds],
      remaining: input.remaining,
      stallCount,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })

    ctx.notifier.notify({
      level: "warn",
      title: `Progress ledger: ${verdict.recommendedAction}`,
      body: verdict.diagnosis,
      runId: ctx.runId,
      teamId: ctx.teamId,
    })

    if (verdict.isSatisfied) {
      for (const t of input.remaining) ctx.storeWriter.setTaskStatus(t.id, "cancelled")
      return { remaining: [], finish: true, decision: continueDecision(verdict.diagnosis) }
    }

    if (verdict.recommendedAction === "consensus" && cfg.allowAutonomousConsensus) {
      openConsensus({
        teamId: ctx.teamId,
        initiatorId: ctx.team.leadId,
        question: `The team has stalled: ${verdict.diagnosis}. How should we proceed?`,
        options: ["Keep the current plan", "Revise the approach"],
      })
      stallCount = 0
    } else if (verdict.recommendedAction === "delegate" && cfg.allowAutonomousDelegation) {
      delegate({
        sourceTeamId: ctx.teamId,
        sourceTaskId: input.justRanTaskIds[0] ?? `stall:${ctx.runId}`,
        prompt: `Unblock the stalled team objective. ${verdict.diagnosis}`,
        reason: "progress-ledger autonomous delegation",
      })
      stallCount = 0
    }

    // Apply any plan changes via the lead re-plan regardless of escalation.
    return replan(input)
  }
}
