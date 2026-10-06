import type { EvalCase, EvalSample, Score } from "./domain/eval"
import type {
  EvalCandidateEvidence,
  EvalExperimentManifest,
  EvalExperimentState,
  EvalRecommendationResult,
  EvalTask,
} from "./types"
import {
  buildEvalCandidateEvidence,
  type EvalEvidenceInput,
  type EvalPairedComparison,
} from "./candidate-evidence"

/** Decrypted evaluation content, with no dependency on encryption or database rows. */
export interface EvalPersistedArtifact {
  case: EvalCase
  sample: EvalSample
  variantId: string
  repetition: 1 | 2 | 3
}

export type EvalReportScore = Pick<Score, "scorerId" | "value" | "passed" | "reasoning" | "error"> &
  Partial<Pick<Score, "status" | "dimension">> & { id: string; scorerVersion: string }

export interface EvalReportCaseInput extends EvalPersistedArtifact {
  sampleId: string
  taskId: string
  scores: EvalReportScore[]
}

export interface EvalReportCaseEvidence extends EvalReportCaseInput {
  status: "passed" | "failed" | "errored"
}

export interface EvalReportExperiment {
  id: string
  projectId: string
  manifest: EvalExperimentManifest
  state: EvalExperimentState
  createdAt: number
  updatedAt: number
}

export interface EvalReportRecommendation {
  id: string
  result: EvalRecommendationResult
  evidenceDigest: string
  pairedComparisons?: EvalPairedComparison[]
  createdAt: number
}

export interface EvalReportView {
  experiment: EvalReportExperiment
  recommendation?: EvalReportRecommendation
  evidence: EvalCandidateEvidence[]
  cases: EvalReportCaseEvidence[]
  cost: { actual: number; estimatedWorstCase: number; hardCap: number }
  providerErrors: Array<{ taskId: string; providerId?: string; error: string }>
}

export interface EvalReportInput extends EvalEvidenceInput {
  experiment: EvalReportExperiment & { budgetCap?: number }
  tasks: ReadonlyArray<
    Pick<EvalTask, "id" | "estimatedWorstCaseCost"> & { providerId?: string; lastError?: string }
  >
  recommendations: readonly EvalReportRecommendation[]
  cases: readonly EvalReportCaseInput[]
}

/** Project an explicit report DTO; never spread persisted or decrypted row objects. */
export function buildEvalReportView(input: EvalReportInput): EvalReportView {
  const { experiment, tasks, samples, scores } = input
  const recommendation = [...input.recommendations].sort((a, b) => b.createdAt - a.createdAt)[0]
  return {
    experiment: {
      id: experiment.id,
      projectId: experiment.projectId,
      manifest: experiment.manifest,
      state: experiment.state,
      createdAt: experiment.createdAt,
      updatedAt: experiment.updatedAt,
    },
    recommendation: recommendation
      ? {
          id: recommendation.id,
          result: recommendation.result,
          evidenceDigest: recommendation.evidenceDigest,
          pairedComparisons: recommendation.pairedComparisons,
          createdAt: recommendation.createdAt,
        }
      : undefined,
    evidence: buildEvalCandidateEvidence(experiment.manifest, { samples, scores }),
    cases: input.cases.map((item) => {
      const reportScores: EvalReportScore[] = item.scores.map((score) => ({
        id: score.id,
        scorerId: score.scorerId,
        scorerVersion: score.scorerVersion,
        value: score.value,
        passed: score.passed,
        status: score.status,
        dimension: score.dimension,
        reasoning: score.reasoning,
        error: score.error,
      }))
      const scored = reportScores.filter(
        (score) => score.status === undefined || score.status === "scored"
      )
      return {
        case: item.case,
        sample: item.sample,
        variantId: item.variantId,
        repetition: item.repetition,
        sampleId: item.sampleId,
        taskId: item.taskId,
        scores: reportScores,
        status:
          item.sample.error || reportScores.some((score) => score.status === "errored")
            ? "errored"
            : scored.length > 0 && scored.every((score) => score.passed)
              ? "passed"
              : "failed",
      }
    }),
    cost: {
      actual: samples.reduce((sum, sample) => sum + sample.actualCost, 0),
      estimatedWorstCase: tasks.reduce((sum, task) => sum + (task.estimatedWorstCaseCost ?? 0), 0),
      hardCap: experiment.budgetCap ?? experiment.manifest.budget.hardCap,
    },
    providerErrors: tasks.flatMap((task) =>
      task.lastError
        ? [{ taskId: task.id, providerId: task.providerId, error: task.lastError }]
        : []
    ),
  }
}

export interface EvalReportFilters {
  split?: string
  tag?: string
  variantId?: string
  scorerId?: string
  status?: EvalReportCaseEvidence["status"]
}

export function filterEvalReportCases(
  cases: EvalReportCaseEvidence[],
  filters: EvalReportFilters
): EvalReportCaseEvidence[] {
  return cases.filter((item) => {
    if (filters.split && item.case.split !== filters.split) return false
    if (filters.tag && !item.case.tags?.includes(filters.tag)) return false
    if (filters.variantId && item.variantId !== filters.variantId) return false
    if (filters.scorerId && !item.scores.some((score) => score.scorerId === filters.scorerId))
      return false
    if (filters.status && item.status !== filters.status) return false
    return true
  })
}
