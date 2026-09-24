/**
 * Segmented "wave" runner for adaptive re-planning (ADR-0022 follow-up). The
 * workflow orchestrator freezes its graph at entry and cannot inject nodes
 * mid-run, so instead of one `runWorkflow` over the full DAG, the flat team path
 * runs as a sequence of Kahn-layer waves. Each wave is a synthesized
 * sub-workflow over the currently-ready tasks; between waves a lead checkpoint
 * may revise the remaining plan.
 *
 * Cross-wave dependencies resolve via the blackboard (the dispatch executor
 * reads upstream results through `readDependencyResults`), and every wave reuses
 * the SAME `runId` so the run row is overwritten in place (single-run view).
 *
 * Only engaged when `team.config.adaptiveReplan.enabled` — the runtime keeps the
 * legacy single-pass path otherwise.
 */
import type { AgentTeamTask } from "@/types/agent/agent-team"
import type { VisualWorkflow } from "@/types/workflow/visual"
import type { RunWorkflowResult } from "@/lib/workflow/runtime/orchestrator"
import type { TeamRunContext } from "./team-run-context"
import { synthesizeTeamWorkflow, validateTeamTaskGraph } from "./synthesize-workflow"
import { runReplanCheckpoint, type ReplanCheckpointOutcome } from "./durable/replan-checkpoint"
import { continueDecision } from "./gates/replan-schema"

export type WaveRunStatus = "succeeded" | "failed" | "cancelled"

export interface TeamWaveRunnerDeps {
  teamCtx: TeamRunContext
  tasks: AgentTeamTask[]
  initialConcurrency: number
  wallClockTimeoutMs?: number
  satisfiedDependencyIds?: ReadonlySet<string>
  signal: AbortSignal
  errorPolicy?: "stop" | "continue"
  /** Run one synthesized wave; returns the orchestrator result. */
  runWave: (workflow: VisualWorkflow, signal: AbortSignal) => Promise<RunWorkflowResult>
  /** Between-wave checkpoint; defaults to `runReplanCheckpoint`. Injectable. */
  checkpoint?: (input: {
    justRanTaskIds: string[]
    remaining: AgentTeamTask[]
    signal: AbortSignal
  }) => Promise<ReplanCheckpointOutcome>
  /** Injectable synthesizer (defaults to `synthesizeTeamWorkflow`). For tests. */
  synthesize?: typeof synthesizeTeamWorkflow
}

export interface TeamWaveRunnerResult {
  status: WaveRunStatus
  waves: number
  lastResult?: RunWorkflowResult
  error?: { message: string; nodeId?: string; code?: string }
}

export async function runTeamWaves(deps: TeamWaveRunnerDeps): Promise<TeamWaveRunnerResult> {
  const deadline =
    deps.wallClockTimeoutMs && deps.wallClockTimeoutMs > 0
      ? Date.now() + deps.wallClockTimeoutMs
      : undefined
  const controller = new AbortController()
  const signal = AbortSignal.any([deps.signal, controller.signal])
  const timeout =
    deadline === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new Error("AgentTeam wave deadline exceeded")),
          Math.max(0, deadline - Date.now())
        )
  try {
    const result = await runWaves({ ...deps, signal }, deadline)
    if (controller.signal.aborted) {
      return {
        ...result,
        status: "failed",
        error: { message: "AgentTeam wave deadline exceeded", code: "timeout" },
      }
    }
    return result
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function runWaves(
  deps: TeamWaveRunnerDeps,
  deadline?: number
): Promise<TeamWaveRunnerResult> {
  const { teamCtx, signal } = deps
  const errorPolicy = deps.errorPolicy ?? "stop"
  const synthesize = deps.synthesize ?? synthesizeTeamWorkflow
  const checkpoint =
    deps.checkpoint ??
    ((input) =>
      runReplanCheckpoint({
        teamCtx,
        runId: teamCtx.runId,
        justRanTaskIds: input.justRanTaskIds,
        remaining: input.remaining,
        signal,
      }))

  let remaining = [...deps.tasks]
  const doneIds = new Set(deps.satisfiedDependencyIds)
  const failedIds = new Set<string>()
  let firstFailure: RunWorkflowResult["error"] | undefined
  let waves = 0
  let lastResult: RunWorkflowResult | undefined

  while (remaining.length > 0) {
    if (signal.aborted) {
      return { status: "cancelled", waves, ...(lastResult ? { lastResult } : {}) }
    }

    try {
      if (remaining.some((task) => doneIds.has(task.id) || failedIds.has(task.id))) {
        throw new Error("Adaptive plan cannot reuse an already executed task id")
      }
      validateTeamTaskGraph(remaining, new Set([...doneIds, ...failedIds]))
    } catch (error) {
      return {
        status: "failed",
        waves,
        lastResult,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "invalid_dep",
        },
      }
    }
    const ready = remaining.filter((t) => t.dependencies.every((d) => doneIds.has(d)))
    if (ready.length === 0) {
      return {
        status: "failed",
        waves,
        ...(lastResult ? { lastResult } : {}),
        error: firstFailure ?? {
          message: "adaptive re-plan: no ready tasks (unsatisfiable dependencies)",
        },
      }
    }

    const waveIds = new Set(ready.map((t) => t.id))

    let workflow: VisualWorkflow
    try {
      ;({ workflow } = synthesize({
        team: teamCtx.team,
        tasks: ready,
        initialConcurrency: deps.initialConcurrency,
        ...(deadline !== undefined
          ? { wallClockTimeoutMs: Math.max(1, deadline - Date.now()) }
          : {}),
        satisfiedDependencyIds: doneIds,
      }))
    } catch (err) {
      return {
        status: "failed",
        waves,
        ...(lastResult ? { lastResult } : {}),
        error: { message: err instanceof Error ? err.message : String(err) },
      }
    }

    let result: RunWorkflowResult
    try {
      result = await deps.runWave(workflow, signal)
    } catch (error) {
      return {
        status: signal.aborted ? "cancelled" : "failed",
        waves,
        lastResult,
        error: { message: error instanceof Error ? error.message : String(error) },
      }
    }
    waves += 1
    lastResult = result

    if (result.status !== "succeeded") {
      if (errorPolicy === "stop" || result.status === "cancelled") {
        return {
          status: result.status === "cancelled" ? "cancelled" : "failed",
          waves,
          lastResult,
          ...(result.error ? { error: result.error } : {}),
        }
      }
      firstFailure ??= result.error ?? { message: "AgentTeam wave failed" }
      for (const id of waveIds) failedIds.add(id)
    } else {
      for (const id of waveIds) doneIds.add(id)
    }

    remaining = remaining.filter((t) => !waveIds.has(t.id))
    if (signal.aborted) return { status: "cancelled", waves, lastResult }

    // Re-plan checkpoint after EVERY wave — including the one that empties the
    // plan, so the lead can inject follow-up work after seeing final results.
    // (Fail-open; abort = cancellation. Loop exits naturally if the plan stays
    // empty and the lead does not inject.)
    let outcome: ReplanCheckpointOutcome
    try {
      outcome = await checkpoint({ justRanTaskIds: [...waveIds], remaining, signal })
    } catch (err) {
      if (signal.aborted) return { status: "cancelled", waves, lastResult }
      // A checkpoint failure must not corrupt the run — continue with the plan.
      void err
      outcome = { remaining, finish: false, decision: continueDecision("Checkpoint failed.") }
    }
    remaining = outcome.remaining
    if (outcome.finish) break
  }

  if (signal.aborted) return { status: "cancelled", waves, lastResult }
  return {
    status: firstFailure ? "failed" : "succeeded",
    waves,
    ...(lastResult ? { lastResult } : {}),
    ...(firstFailure ? { error: firstFailure } : {}),
  }
}
