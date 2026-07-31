/**
 * Seed a judge-calibration set from a real eval run.
 *
 * Calibration answers "do I trust this judge?" by comparing its verdicts
 * against human gold labels — but a set could only be built by retyping
 * (request, answer) pairs by hand, which meant nobody built one, which meant
 * the judge's agreement was never measured. Every input it needs is already
 * sitting in a completed run: the case prompt, what the agent actually
 * answered, and the judge's verdict with its reasoning.
 *
 * The judge's verdict is carried across as the STARTING gold label, deliberately
 * pre-filled rather than left blank: a human confirming or flipping a proposed
 * label is a far cheaper review than labelling from scratch, and Cohen's κ only
 * needs the disagreements to be found. `notes` records the judge's reasoning so
 * the reviewer can see why it decided that.
 *
 * Pure over injected persistence so it is testable without Dexie.
 */

import type { CalibrationLabel, UpsertCalibrationItemInput } from "@/lib/db/calibration-items"
import type { EvalRunCaseRow } from "@/lib/db/eval-run-cases"

export interface SeedFromRunInput {
  /** Calibration set to add to; created lazily by its first item. */
  setId: string
  /** The judge being calibrated — one criterion per set. */
  criterion: string
  rubric: string
  /** Scorer id whose verdicts seed the labels, e.g. `judge-task-completion`. */
  scorerId: string
  /** Per-case rows of the run, from `listCaseResults(runId)`. */
  rows: EvalRunCaseRow[]
  /** caseId → the prompt that drove the case. */
  inputsByCase: Record<string, string>
  /** caseId → the case's golden answer, when it has one. */
  referencesByCase?: Record<string, string>
}

export interface SeedFromRunResult {
  items: UpsertCalibrationItemInput[]
  /** Rows that carried no usable (answer, verdict) pair, with the reason. */
  skipped: { caseId: string; reason: string }[]
}

/**
 * Build the calibration items a run can contribute. Rows are skipped rather
 * than guessed at when the judge did not produce a verdict, or when the run
 * kept no answer (output storage disabled) — a calibration item with no answer
 * is not something a human can label.
 */
export function buildCalibrationSeed(input: SeedFromRunInput): SeedFromRunResult {
  const items: UpsertCalibrationItemInput[] = []
  const skipped: { caseId: string; reason: string }[] = []

  for (const row of input.rows) {
    const score = row.scores[input.scorerId]
    if (!score) {
      skipped.push({ caseId: row.caseId, reason: "scorer did not run on this case" })
      continue
    }
    if (score.status !== undefined && score.status !== "scored") {
      skipped.push({ caseId: row.caseId, reason: `verdict was ${score.status}` })
      continue
    }
    if (!row.output) {
      skipped.push({ caseId: row.caseId, reason: "run kept no answer for this case" })
      continue
    }
    const prompt = input.inputsByCase[row.caseId]
    if (!prompt) {
      skipped.push({ caseId: row.caseId, reason: "case no longer exists" })
      continue
    }
    const goldLabel: CalibrationLabel = score.passed ? "pass" : "fail"
    const reference = input.referencesByCase?.[row.caseId]
    items.push({
      setId: input.setId,
      criterion: input.criterion,
      rubric: input.rubric,
      input: prompt,
      output: row.output,
      // Seeded with the judge's own verdict for the human to confirm or flip.
      goldLabel,
      source: "eval-case",
      sourceCaseId: row.caseId,
      ...(reference ? { reference } : {}),
      ...(score.reasoning ? { notes: score.reasoning } : {}),
    })
  }

  return { items, skipped }
}

/** Scorer ids in a run's rows that produced at least one real verdict. */
export function judgeScorerIds(rows: EvalRunCaseRow[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    for (const [id, score] of Object.entries(row.scores)) {
      if (score.status === undefined || score.status === "scored") ids.add(id)
    }
  }
  return [...ids].sort()
}
