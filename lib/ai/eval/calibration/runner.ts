/**
 * Judge calibration runner (eval spec §10).
 *
 * Runs a chosen LLM-judge over a human-labeled calibration set and compares the
 * judge's binary verdict to the human gold label, producing agreement metrics
 * (confusion matrix + TPR/TNR/precision/F1/accuracy + Cohen's κ). The judge
 * engine is REUSED verbatim — `makeJudgeScorer` scores a synthetic
 * `(EvalSample, EvalCase)` pair built from each calibration item; the only glue
 * is that adapter. Cross-model judging (don't judge with the model that wrote
 * the answer) is the caller's concern, same as the eval judge.
 *
 * DI-friendly like `lib/ai/eval/service.ts`: inject `deps` in tests to avoid a
 * real LLM / Dexie. The default deps build a renderer judge via
 * `buildRendererLlmClient`; unlike eval (which degrades to deterministic-only),
 * calibration is meaningless without a judge, so a missing client throws
 * {@link CalibrationNoJudgeError}.
 */

import type { AppSettings } from "@/lib/claude/types"
import type { EvalCase, EvalSample, Scorer } from "@/types/eval/eval"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { makeJudgeScorer } from "@/lib/ai/eval/scorers/judge"
import { listItemsBySet, type CalibrationItemRow } from "@/lib/db/calibration-items"
import {
  saveCalibrationRun,
  type CalibrationRunRow,
  type CalibrationVerdict,
} from "@/lib/db/calibration-runs"
import { computeAgreement, type LabelPair } from "./metrics"

/** Thrown by the default deps when no renderer judge client resolves. */
export class CalibrationNoJudgeError extends Error {
  constructor() {
    super("No renderer judge model resolved — calibration requires an LLM judge.")
    this.name = "CalibrationNoJudgeError"
  }
}

export interface CalibrationRunDeps {
  loadItems: (setId: string) => Promise<CalibrationItemRow[]>
  saveRun: (row: CalibrationRunRow) => Promise<void>
  /** Build the judge scorer for one (criterion, rubric). Test seam. */
  makeJudge: (criterion: string, rubric: string) => Scorer
  /** Cross-model judge model label, recorded for provenance. */
  judgeModel: string
  now: () => number
  newRunId: () => string
}

export interface RunCalibrationInput {
  setId: string
  appSettings: AppSettings | null
  /** Override the judge model (cross-model). Defaults to the resolver's choice. */
  judgeModel?: string
  signal?: AbortSignal
  onProgress?: (p: { done: number; total: number }) => void
  /** Defaults to the browser wiring. */
  deps?: CalibrationRunDeps
}

function newCalibrationRunId(): string {
  return "calrun_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/**
 * Build the default (browser) deps. Throws {@link CalibrationNoJudgeError} when
 * no renderer judge client resolves — there is nothing to calibrate without it.
 */
export function buildCalibrationRunDeps(
  appSettings: AppSettings | null,
  judgeModel?: string
): CalibrationRunDeps {
  const client = buildRendererLlmClient({
    session: null,
    appSettings,
    featureId: "eval-calibration",
    ...(judgeModel ? { modelOverride: judgeModel } : {}),
  })
  if (!client) throw new CalibrationNoJudgeError()

  return {
    loadItems: listItemsBySet,
    saveRun: saveCalibrationRun,
    makeJudge: (criterion, rubric) => makeJudgeScorer({ client, criterion, rubric }),
    judgeModel: judgeModel ?? "(resolver default)",
    now: () => Date.now(),
    newRunId: newCalibrationRunId,
  }
}

/** Build the synthetic (sample, case) pair the judge scorer consumes. */
function itemToScorable(item: CalibrationItemRow): { sample: EvalSample; evalCase: EvalCase } {
  const sample: EvalSample = {
    output: item.output,
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    stepCount: 0,
    degraded: false,
  }
  const evalCase: EvalCase = {
    id: item.id,
    datasetId: "",
    input: item.input,
    capability: "",
    source: "handwritten",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.history ? { history: item.history } : {}),
    ...(item.reference ? { reference: { expectedOutput: item.reference } } : {}),
  }
  return { sample, evalCase }
}

/**
 * Calibrate the judge over a set and persist the agreement report.
 *
 * Errored judge verdicts (fail-open) are recorded but excluded from the metric
 * denominator. Aborts (via `signal`) throw `AbortError` and persist nothing,
 * matching the eval runner.
 */
export async function runCalibration(input: RunCalibrationInput): Promise<CalibrationRunRow> {
  const deps = input.deps ?? buildCalibrationRunDeps(input.appSettings, input.judgeModel)
  const items = await deps.loadItems(input.setId)

  // A set is homogeneous (one judge) in v1: snapshot the criterion/rubric from
  // the first item; an empty set yields empty snapshots and null metrics.
  const criterion = items[0]?.criterion ?? ""
  const rubric = items[0]?.rubric ?? ""
  const judge = items.length > 0 ? deps.makeJudge(criterion, rubric) : null

  const verdicts: CalibrationVerdict[] = []
  const pairs: LabelPair[] = []

  for (let i = 0; i < items.length; i++) {
    if (input.signal?.aborted) throw new DOMException("Calibration aborted", "AbortError")
    const item = items[i]
    const { sample, evalCase } = itemToScorable(item)
    // `judge` is non-null here because items.length > 0.
    const score = await judge!.score(sample, evalCase)
    const errored = score.error !== undefined
    const judgePassed = !errored && score.passed
    verdicts.push({
      itemId: item.id,
      goldLabel: item.goldLabel,
      judgeValue: judgePassed ? 1 : 0,
      judgePassed,
      errored,
      ...(score.reasoning !== undefined ? { reasoning: score.reasoning } : {}),
      ...(score.error !== undefined ? { error: score.error } : {}),
    })
    if (!errored) pairs.push({ gold: item.goldLabel === "pass", judge: judgePassed })
    input.onProgress?.({ done: i + 1, total: items.length })
  }

  const erroredCount = verdicts.filter((v) => v.errored).length
  const row: CalibrationRunRow = {
    runId: deps.newRunId(),
    setId: input.setId,
    criterion,
    rubric,
    judgeModel: deps.judgeModel,
    itemCount: items.length,
    scoredCount: pairs.length,
    erroredCount,
    metrics: computeAgreement(pairs),
    verdicts,
    createdAt: deps.now(),
  }
  await deps.saveRun(row)
  return row
}
