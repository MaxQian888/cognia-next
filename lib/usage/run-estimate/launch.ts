/**
 * Estimate one launch (ADR-0232): fill in what a launch surface did not say,
 * estimate each parallel part, and combine.
 *
 * A launch surface knows a model and a provider; it rarely knows a harness or
 * a family. Both are derived here the same way the samples were keyed, so a
 * query and the history it is compared with cannot disagree about what
 * "Codex" or "claude-sonnet" means.
 */

import {
  combineParallelEstimates,
  estimateRun,
  EMPTY_ESTIMATE,
  type RunEstimate,
  type RunEstimateQuery,
} from "./estimate"
import { harnessFromProvider, type ExternalPresetResolver } from "./harness"
import { loadRunEstimateContext, type RunEstimateContext } from "./load-samples"
import { modelFamilyOf } from "./model-family"

/**
 * Complete a query: the family from its model, and its harness from its
 * provider when the caller left the harness `undefined`. An explicit `null`
 * harness ("unknown") is kept.
 */
export function prepareQuery(
  query: RunEstimateQuery,
  resolvePreset: ExternalPresetResolver
): RunEstimateQuery {
  const modelFamily = query.modelFamily ?? modelFamilyOf(query.model)
  const harness =
    query.harness !== undefined
      ? query.harness
      : query.providerId
        ? harnessFromProvider(query.providerId, resolvePreset)
        : undefined
  return { ...query, modelFamily, ...(harness !== undefined ? { harness } : {}) }
}

/** Estimate a launch made of `queries` run side by side. */
export function estimateLaunch(
  queries: readonly RunEstimateQuery[],
  context: RunEstimateContext,
  now: number
): RunEstimate {
  if (queries.length === 0) return EMPTY_ESTIMATE
  const parts = queries.map((query) =>
    estimateRun(context.samples, prepareQuery(query, context.resolvePreset), { now })
  )
  return parts.length === 1 ? parts[0] : combineParallelEstimates(parts)
}

/** {@link estimateLaunch} against the cached history, for callers outside React. */
export async function estimateLaunchNow(
  queries: readonly RunEstimateQuery[],
  now: number = Date.now()
): Promise<RunEstimate> {
  return estimateLaunch(queries, await loadRunEstimateContext({ now }), now)
}
