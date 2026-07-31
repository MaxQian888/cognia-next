import type { EvalCase, EvalSample } from "@/types/eval/eval"
import type { EvalEncryptedEnvelope } from "./artifact-crypto"
import { decryptEvalArtifact } from "./artifact-crypto"
import type {
  EvalExperimentRow,
  EvalRecommendationRow,
  EvalSampleRow,
  EvalScoreRow,
  EvalTaskRow,
} from "@/lib/db/eval-lab"
import { getDb } from "@/lib/db/schema"
import { buildEvalCandidateEvidence } from "./finalization"

export interface EvalPersistedArtifact {
  case: EvalCase
  sample: EvalSample
  variantId: string
  repetition: 1 | 2 | 3
}

export interface EvalReportCaseEvidence extends EvalPersistedArtifact {
  sampleId: string
  taskId: string
  scores: Array<EvalScoreRow & { reasoning?: string }>
  status: "passed" | "failed" | "errored"
}

export interface EvalReportView {
  experiment: EvalExperimentRow
  recommendation?: EvalRecommendationRow
  evidence: ReturnType<typeof buildEvalCandidateEvidence>
  cases: EvalReportCaseEvidence[]
  cost: { actual: number; estimatedWorstCase: number; hardCap: number }
  providerErrors: Array<{ taskId: string; providerId?: string; error: string }>
}

export interface EvalReportViewDependencies {
  loadExperiment(id: string): Promise<EvalExperimentRow | undefined>
  loadTasks(experimentId: string): Promise<EvalTaskRow[]>
  loadSamples(experimentId: string): Promise<EvalSampleRow[]>
  loadScores(experimentId: string): Promise<EvalScoreRow[]>
  loadRecommendations(experimentId: string): Promise<EvalRecommendationRow[]>
  decryptArtifact<T>(key: Uint8Array, envelope: EvalEncryptedEnvelope): Promise<T>
}

const defaultDependencies: EvalReportViewDependencies = {
  loadExperiment: (id) => getDb().evalExperiments.get(id),
  loadTasks: (id) => getDb().evalTasks.where("experimentId").equals(id).toArray(),
  loadSamples: (id) => getDb().evalSamples.where("experimentId").equals(id).toArray(),
  loadScores: (id) => getDb().evalScores.where("experimentId").equals(id).toArray(),
  loadRecommendations: (id) =>
    getDb().evalRecommendations.where("experimentId").equals(id).toArray(),
  decryptArtifact: decryptEvalArtifact,
}

export async function loadEvalReportView(
  experimentId: string,
  artifactKey: Uint8Array,
  dependencies: EvalReportViewDependencies = defaultDependencies
): Promise<EvalReportView> {
  const experiment = await dependencies.loadExperiment(experimentId)
  if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
  const [tasks, samples, scores, recommendations] = await Promise.all([
    dependencies.loadTasks(experimentId),
    dependencies.loadSamples(experimentId),
    dependencies.loadScores(experimentId),
    dependencies.loadRecommendations(experimentId),
  ])
  const scoresBySample = new Map<string, EvalScoreRow[]>()
  for (const score of scores) {
    const rows = scoresBySample.get(score.sampleId) ?? []
    rows.push(score)
    scoresBySample.set(score.sampleId, rows)
  }
  const cases = await Promise.all(
    samples.map(async (sampleRow): Promise<EvalReportCaseEvidence> => {
      const artifact = await dependencies.decryptArtifact<EvalPersistedArtifact>(
        artifactKey,
        sampleRow.encryptedArtifact
      )
      const sampleScores = await Promise.all(
        (scoresBySample.get(sampleRow.id) ?? []).map(async (score) => ({
          ...score,
          ...(score.encryptedReasoning
            ? await dependencies.decryptArtifact<{ reasoning: string }>(
                artifactKey,
                score.encryptedReasoning
              )
            : {}),
        }))
      )
      const scored = sampleScores.filter(
        (score) => score.status === undefined || score.status === "scored"
      )
      return {
        ...artifact,
        sampleId: sampleRow.id,
        taskId: sampleRow.taskId,
        scores: sampleScores,
        status:
          artifact.sample.error || sampleScores.some((score) => score.status === "errored")
            ? "errored"
            : scored.length > 0 && scored.every((score) => score.passed)
              ? "passed"
              : "failed",
      }
    })
  )
  return {
    experiment,
    recommendation: [...recommendations].sort((a, b) => b.createdAt - a.createdAt)[0],
    evidence: buildEvalCandidateEvidence(experiment.manifest, { samples, scores }),
    cases,
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
    if (filters.scorerId && !item.scores.some((score) => score.scorerId === filters.scorerId)) {
      return false
    }
    if (filters.status && item.status !== filters.status) return false
    return true
  })
}
