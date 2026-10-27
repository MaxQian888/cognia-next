/**
 * Eval runner — the Phase 0 orchestrator.
 *
 * For each {@link EvalCase} it drives the {@link EvalTarget} `k` times
 * (pass^k reliability), assembles each run into an {@link EvalSample}, and
 * applies every {@link Scorer}. Failures are isolated, never fatal:
 *  - a target throw becomes an errored, degraded sample (scorers still run);
 *  - a scorer throw becomes an errored {@link Score} (other scorers unaffected).
 *
 * The runner is pure orchestration over an injected target, so it is fully
 * unit-testable with a mock target — the real sidecar bridge lives in
 * `lib/ai/eval/targets/chat.ts`.
 */

import type { EvalCase, EvalCaseResult, EvalSample, Score, Scorer } from "./domain/eval"

/** A target runs one case and returns the captured trajectory. */
export interface EvalTarget {
  /** Human label for the config under test (model / character). */
  label: string
  run(evalCase: EvalCase, signal?: AbortSignal): Promise<EvalSample>
}

export interface RunEvalOptions {
  cases: EvalCase[]
  scorers: Scorer[]
  target: EvalTarget
  /** Repetitions per case (pass^k). Default 1. */
  k?: number
  signal?: AbortSignal
  /** Progress callback fired after each case completes. */
  onCaseComplete?: (result: EvalCaseResult, index: number) => void | Promise<void>
}

function erroredSample(
  message: string,
  status: EvalSample["executionStatus"],
  elapsedMs = 0
): EvalSample {
  return {
    output: "",
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: elapsedMs,
    stepCount: 0,
    degraded: true,
    error: message,
    executionStatus: status,
    metricAvailability: {
      usage: "unavailable",
      cost: "unavailable",
      latency: "known",
      steps: "unavailable",
    },
  }
}

async function safeRun(
  target: EvalTarget,
  evalCase: EvalCase,
  signal?: AbortSignal
): Promise<EvalSample> {
  const startedAt = Date.now()
  try {
    return await target.run(evalCase, signal)
  } catch (err) {
    return erroredSample(
      err instanceof Error ? err.message : String(err),
      err instanceof Error && err.name === "TimeoutError"
        ? "timed_out"
        : signal?.aborted || (err instanceof Error && err.name === "AbortError")
          ? "cancelled"
          : "failed",
      Math.max(0, Date.now() - startedAt)
    )
  }
}

/**
 * Run one scorer, converting a scorer crash into an `errored` observation.
 *
 * Exported because every driver that scores samples outside {@link runEval} —
 * the CLI's checkpointed loop, for one — must apply the same rule: the SCORER
 * blowing up is never an agent failure. Re-deriving that per driver is how the
 * CLI ended up with its own quality heuristic.
 */
export async function safeScore(
  scorer: Scorer,
  sample: EvalSample,
  evalCase: EvalCase
): Promise<Score> {
  try {
    return await scorer.score(sample, evalCase)
  } catch (err) {
    // The SCORER blew up, not the agent — `errored`, never a failed verdict.
    return {
      scorerId: scorer.id,
      dimension: scorer.dimension,
      status: "errored",
      value: 0,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function runEval(options: RunEvalOptions): Promise<EvalCaseResult[]> {
  const { cases, scorers, target, signal, onCaseComplete } = options
  const k = Math.max(1, Math.floor(options.k ?? 1))
  const results: EvalCaseResult[] = []

  for (let i = 0; i < cases.length; i++) {
    if (signal?.aborted) break
    const evalCase = cases[i]
    const repetitions: EvalCaseResult["repetitions"] = []
    for (let r = 0; r < k; r++) {
      if (signal?.aborted) break
      const sample = await safeRun(target, evalCase, signal)
      const scores = await Promise.all(scorers.map((s) => safeScore(s, sample, evalCase)))
      repetitions.push({ sample, scores })
    }
    if (repetitions.length === 0) break
    // Partial samples retain billed work and elapsed time. Reliability only
    // uses complete k-case results; interruption cannot erase accounting.
    const result: EvalCaseResult = {
      caseId: evalCase.id,
      repetitions,
      expectedRepetitions: k,
      status: repetitions.length === k ? "completed" : "partial",
    }
    results.push(result)
    await onCaseComplete?.(result, i)
    if (repetitions.length < k) break
  }

  return results
}
