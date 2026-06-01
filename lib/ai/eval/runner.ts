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
 * `lib/ai/eval/target.ts`.
 */

import type { EvalCase, EvalCaseResult, EvalSample, Score, Scorer } from "@/types/eval/eval"

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
  onCaseComplete?: (result: EvalCaseResult, index: number) => void
}

function erroredSample(message: string): EvalSample {
  return {
    output: "",
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    stepCount: 0,
    degraded: true,
    error: message,
  }
}

async function safeRun(
  target: EvalTarget,
  evalCase: EvalCase,
  signal?: AbortSignal
): Promise<EvalSample> {
  try {
    return await target.run(evalCase, signal)
  } catch (err) {
    return erroredSample(err instanceof Error ? err.message : String(err))
  }
}

async function safeScore(scorer: Scorer, sample: EvalSample, evalCase: EvalCase): Promise<Score> {
  try {
    return await scorer.score(sample, evalCase)
  } catch (err) {
    return {
      scorerId: scorer.id,
      dimension: scorer.dimension,
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
    // A case interrupted mid-repetitions (abort) is dropped — partial pass^k is
    // meaningless. Only fully-completed cases are reported.
    if (repetitions.length < k) break
    const result: EvalCaseResult = { caseId: evalCase.id, repetitions }
    results.push(result)
    onCaseComplete?.(result, i)
  }

  return results
}
