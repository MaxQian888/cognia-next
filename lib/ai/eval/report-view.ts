import {
  buildEvalReportView,
  type EvalPersistedArtifact,
  type EvalReportCaseInput,
  type EvalReportView,
} from "@cognia/eval-core"
export {
  filterEvalReportCases,
  type EvalPersistedArtifact,
  type EvalReportCaseEvidence,
  type EvalReportView,
  type EvalReportFilters,
} from "@cognia/eval-core"
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
    samples.map(async (sampleRow): Promise<EvalReportCaseInput> => {
      const artifact = await dependencies.decryptArtifact<EvalPersistedArtifact>(
        artifactKey,
        sampleRow.encryptedArtifact
      )
      const sampleScores = await Promise.all(
        (scoresBySample.get(sampleRow.id) ?? []).map(async (score) => ({
          id: score.id,
          scorerId: score.scorerId,
          scorerVersion: score.scorerVersion,
          value: score.value,
          passed: score.passed,
          status: score.status,
          dimension: score.dimension,
          error: score.error,
          reasoning: score.encryptedReasoning
            ? (
                await dependencies.decryptArtifact<{ reasoning: string }>(
                  artifactKey,
                  score.encryptedReasoning
                )
              ).reasoning
            : undefined,
        }))
      )
      return {
        case: artifact.case,
        sample: artifact.sample,
        variantId: artifact.variantId,
        repetition: artifact.repetition,
        sampleId: sampleRow.id,
        taskId: sampleRow.taskId,
        scores: sampleScores,
      }
    })
  )
  return buildEvalReportView({ experiment, tasks, samples, scores, recommendations, cases })
}
