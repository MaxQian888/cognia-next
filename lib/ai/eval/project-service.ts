import {
  runProjectPreflight,
  type EvalEnvironmentCompatibility,
  type EvalExperimentManifest,
  type EvalPreflightResult,
  type EvalTaskState,
  type EvalVariant,
  type EvalProject,
} from "@cognia/eval-core"
import { createEvalExperiment, getEvalExperiment, type EvalExperimentRow } from "@/lib/db/eval-lab"
import { getDb } from "@/lib/db/schema"

type EvalEnvironmentChecker = (project: EvalProject) => Promise<EvalEnvironmentCompatibility>

export interface EvalProjectServiceOptions {
  now?: () => number
  newId?: () => string
  checkEnvironment?: EvalEnvironmentChecker
}

export interface EvalStartOptions {
  appVersion: string
  scorerVersions: Record<string, string>
  randomSeed: number
  environmentCompatibility: EvalEnvironmentCompatibility
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value))
  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )
  return `sha256:${Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}

function estimateWorstCaseCost(
  variant: EvalVariant,
  judgePolicy: EvalProject["judgePolicy"]
): number {
  const inputTokens = Number(variant.parameters?.estimatedInputTokens ?? 8_192)
  const outputTokens = Number(variant.parameters?.maxOutputTokens ?? 4_096)
  const targetCost =
    variant.isLocal || !variant.price
      ? 0
      : (inputTokens * variant.price.inputPerMillion +
          outputTokens * variant.price.outputPerMillion) /
        1_000_000
  if (!judgePolicy.enabled || judgePolicy.isLocal || !judgePolicy.price) return targetCost
  const judgeInputTokens = inputTokens + outputTokens
  const judgeOutputTokens = judgePolicy.maxOutputTokens ?? 300
  const judgeCallCount = 5
  const primaryJudgeCost =
    (judgeCallCount *
      (judgeInputTokens * judgePolicy.price.inputPerMillion +
        judgeOutputTokens * judgePolicy.price.outputPerMillion)) /
    1_000_000
  const secondJudgeCost =
    judgePolicy.secondJudgeIsLocal || !judgePolicy.secondJudgePrice
      ? 0
      : (judgeCallCount *
          (judgeInputTokens * judgePolicy.secondJudgePrice.inputPerMillion +
            judgeOutputTokens * judgePolicy.secondJudgePrice.outputPerMillion)) /
        1_000_000
  return targetCost + primaryJudgeCost + secondJudgeCost
}

export class EvalProjectService {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly checkEnvironment: EvalEnvironmentChecker

  constructor(options: EvalProjectServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.checkEnvironment =
      options.checkEnvironment ??
      (async (project) =>
        (await import("./environment-preflight")).checkEvalEnvironmentCompatibility(project))
  }

  async environment(projectId: string): Promise<EvalEnvironmentCompatibility> {
    const project = await getDb().evalProjects.get(projectId)
    if (!project) throw new Error(`Evaluation project ${projectId} not found`)
    return this.checkEnvironment(project)
  }

  async verifiedPreflight(projectId: string): Promise<{
    environmentCompatibility: EvalEnvironmentCompatibility
    result: EvalPreflightResult
  }> {
    const project = await getDb().evalProjects.get(projectId)
    if (!project) throw new Error(`Evaluation project ${projectId} not found`)
    const environmentCompatibility = await this.checkEnvironment(project)
    return {
      environmentCompatibility,
      result: runProjectPreflight(
        {
          ...project,
          variants: project.variants.map((variant) => ({
            ...variant,
            runtimeReady: environmentCompatibility.runtimeByVariant[variant.id]?.available ?? false,
          })),
        },
        environmentCompatibility
      ),
    }
  }

  async preflight(
    projectId: string,
    environmentCompatibility?: EvalEnvironmentCompatibility
  ): Promise<EvalPreflightResult> {
    const project = await getDb().evalProjects.get(projectId)
    if (!project) throw new Error(`Evaluation project ${projectId} not found`)
    return runProjectPreflight(project, environmentCompatibility)
  }

  async start(projectId: string, options: EvalStartOptions): Promise<EvalExperimentRow> {
    const db = getDb()
    const project = await db.evalProjects.get(projectId)
    if (!project) throw new Error(`Evaluation project ${projectId} not found`)
    const projectWithRuntime = {
      ...project,
      variants: project.variants.map((variant) => ({
        ...variant,
        runtimeReady:
          options.environmentCompatibility.runtimeByVariant[variant.id]?.available ?? false,
      })),
    }
    const preflight = runProjectPreflight(projectWithRuntime, options.environmentCompatibility)
    if (!preflight.ok) {
      throw new Error(
        `Evaluation preflight failed: ${preflight.issues.map((issue) => issue.code).join(", ")}`
      )
    }
    const createdAt = this.now()
    const experimentId = this.newId()
    const compatible = projectWithRuntime.variants.filter((variant) =>
      preflight.compatibleVariantIds.includes(variant.id)
    )
    const manifest: EvalExperimentManifest = {
      id: experimentId,
      projectId: project.id,
      projectRevision: await digest(project),
      dataset: structuredClone(projectWithRuntime.dataset),
      variants: structuredClone(compatible),
      mode: projectWithRuntime.mode,
      appVersion: options.appVersion,
      scorerVersions: structuredClone(options.scorerVersions),
      privacyPolicy: structuredClone(projectWithRuntime.privacyPolicy),
      randomSeed: options.randomSeed,
      budget: structuredClone(projectWithRuntime.budget),
      judgePolicy: structuredClone(projectWithRuntime.judgePolicy),
      decisionPolicy: structuredClone(projectWithRuntime.decisionPolicy),
      retentionDays: projectWithRuntime.retentionDays,
      adaptiveRepetitions: { stageOne: 1, maximum: 3 },
      environmentCompatibility: structuredClone(options.environmentCompatibility),
      createdAt,
    }
    await createEvalExperiment(manifest)
    const tasks = compatible.flatMap((variant) =>
      preflight.effectiveCaseIds.map((caseId) => ({
        id: this.newId(),
        experimentId,
        variantId: variant.id,
        caseId,
        repetition: 1 as const,
        state: "queued" as const,
        attempt: 0,
        reservedCost: 0,
        estimatedWorstCaseCost: estimateWorstCaseCost(variant, project.judgePolicy),
        providerId: variant.providerId,
        updatedAt: createdAt,
      }))
    )
    await db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
      if (tasks.length) await db.evalTasks.bulkAdd(tasks)
      await db.evalExperiments.update(experimentId, { state: "queued", updatedAt: createdAt })
    })
    const created = await getEvalExperiment(experimentId)
    if (!created) throw new Error(`Evaluation experiment ${experimentId} was not persisted`)
    return created
  }

  async pause(experimentId: string): Promise<void> {
    await getDb().evalExperiments.update(experimentId, {
      state: "paused",
      pauseReason: "user",
      updatedAt: this.now(),
    })
  }

  async resume(experimentId: string): Promise<void> {
    await getDb().evalExperiments.update(experimentId, {
      state: "queued",
      pauseReason: undefined,
      updatedAt: this.now(),
    })
  }

  async cancel(experimentId: string): Promise<void> {
    const db = getDb()
    const now = this.now()
    await db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
      await db.evalTasks
        .where("experimentId")
        .equals(experimentId)
        .filter((task) => !["completed", "failed", "cancelled", "interrupted"].includes(task.state))
        .modify({ state: "cancelled", reservedCost: 0, updatedAt: now })
      await db.evalExperiments.update(experimentId, {
        state: "cancelled",
        reservedCost: 0,
        updatedAt: now,
      })
    })
  }

  async extendBudget(experimentId: string, nextCap: number): Promise<void> {
    const db = getDb()
    await db.transaction("rw", db.evalExperiments, async () => {
      const experiment = await db.evalExperiments.get(experimentId)
      if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
      const currentCap = experiment.budgetCap ?? experiment.manifest.budget.hardCap
      if (!Number.isFinite(nextCap) || nextCap <= currentCap) {
        throw new Error("The extended evaluation budget must be greater than the current cap")
      }
      await db.evalExperiments.update(experimentId, {
        budgetCap: nextCap,
        budgetExtensions: [
          ...(experiment.budgetExtensions ?? []),
          { previousCap: currentCap, nextCap, createdAt: this.now() },
        ],
        updatedAt: this.now(),
      })
    })
  }

  async status(experimentId: string): Promise<{
    experiment: EvalExperimentRow
    tasks: Partial<Record<EvalTaskState, number>>
  }> {
    const db = getDb()
    const experiment = await db.evalExperiments.get(experimentId)
    if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
    const rows = await db.evalTasks.where("experimentId").equals(experimentId).toArray()
    const tasks: Partial<Record<EvalTaskState, number>> = {}
    for (const row of rows) tasks[row.state] = (tasks[row.state] ?? 0) + 1
    return { experiment, tasks }
  }

  async report(experimentId: string) {
    const db = getDb()
    const status = await this.status(experimentId)
    const [samples, scores, recommendations, reviewBatches, votes, adjudications] =
      await Promise.all([
        db.evalSamples.where("experimentId").equals(experimentId).toArray(),
        db.evalScores.where("experimentId").equals(experimentId).toArray(),
        db.evalRecommendations.where("experimentId").equals(experimentId).toArray(),
        db.evalReviewBatches.where("experimentId").equals(experimentId).toArray(),
        db.evalReviewVotes.where("experimentId").equals(experimentId).toArray(),
        db.evalAdjudications.toArray(),
      ])
    const batchIds = new Set(reviewBatches.map((batch) => batch.id))
    return {
      ...status,
      samples,
      scores,
      recommendations,
      review: {
        batches: reviewBatches,
        votes,
        adjudications: adjudications.filter((item) => batchIds.has(item.batchId)),
      },
    }
  }
}
