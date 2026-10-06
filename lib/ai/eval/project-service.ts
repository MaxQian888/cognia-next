import {
  runProjectPreflight,
  type EvalEnvironmentCompatibility,
  type EvalExperimentManifest,
  type EvalPreflightResult,
  type EvalTaskState,
  type EvalVariant,
  type EvalProject,
} from "@cognia/eval-core"
import {
  createEvalExperiment,
  getEvalExperiment,
  type EvalExperimentRow,
  type EvalPersistenceScope,
} from "@/lib/db/eval-lab"
import { getDb } from "@/lib/db/schema"

type EvalEnvironmentChecker = (project: EvalProject) => Promise<EvalEnvironmentCompatibility>

export interface EvalProjectServiceOptions {
  scope?: EvalPersistenceScope
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

  constructor(private readonly options: EvalProjectServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.checkEnvironment =
      options.checkEnvironment ??
      (async (project) =>
        (await import("./environment-preflight")).checkEvalEnvironmentCompatibility(project))
  }

  private database() {
    this.options.scope?.assertActive()
    return this.options.scope?.db ?? getDb()
  }

  async environment(projectId: string): Promise<EvalEnvironmentCompatibility> {
    const project = await this.database().evalProjects.get(projectId)
    if (!project) throw new Error(`Evaluation project ${projectId} not found`)
    return this.checkEnvironment(project)
  }

  async verifiedPreflight(projectId: string): Promise<{
    environmentCompatibility: EvalEnvironmentCompatibility
    result: EvalPreflightResult
  }> {
    const project = await this.database().evalProjects.get(projectId)
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
    const project = await this.database().evalProjects.get(projectId)
    if (!project) throw new Error(`Evaluation project ${projectId} not found`)
    return runProjectPreflight(project, environmentCompatibility)
  }

  async start(projectId: string, options: EvalStartOptions): Promise<EvalExperimentRow> {
    const db = this.database()
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
    this.options.scope?.assertActive()
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
    await createEvalExperiment(manifest, this.options.scope)
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
      this.options.scope?.assertActive()
      if (tasks.length) await db.evalTasks.bulkAdd(tasks)
      this.options.scope?.assertActive()
      await db.evalExperiments.update(experimentId, { state: "queued", updatedAt: createdAt })
    })
    const created = await getEvalExperiment(experimentId, this.options.scope)
    if (!created) throw new Error(`Evaluation experiment ${experimentId} was not persisted`)
    return created
  }

  private async setUserState(experimentId: string, state: "paused" | "queued"): Promise<void> {
    const db = this.database()
    await db.transaction("rw", db.evalExperiments, async () => {
      const experiment = await db.evalExperiments.get(experimentId)
      this.options.scope?.assertActive()
      if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
      if (["completed", "cancelled", "failed"].includes(experiment.state)) return
      await db.evalExperiments.update(experimentId, {
        state,
        pauseReason: state === "paused" ? "user" : undefined,
        updatedAt: this.now(),
      })
    })
  }

  pause(experimentId: string): Promise<void> {
    return this.setUserState(experimentId, "paused")
  }

  resume(experimentId: string): Promise<void> {
    return this.setUserState(experimentId, "queued")
  }

  async cancel(experimentId: string): Promise<void> {
    const db = this.database()
    const now = this.now()
    await db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
      const experiment = await db.evalExperiments.get(experimentId)
      this.options.scope?.assertActive()
      if (!experiment || ["completed", "cancelled", "failed"].includes(experiment.state)) return
      await db.evalTasks
        .where("experimentId")
        .equals(experimentId)
        .filter((task) => !["completed", "failed", "cancelled", "interrupted"].includes(task.state))
        .modify({ state: "cancelled", reservedCost: 0, updatedAt: now })
      this.options.scope?.assertActive()
      await db.evalExperiments.update(experimentId, {
        state: "cancelled",
        reservedCost: 0,
        updatedAt: now,
      })
    })
  }

  async extendBudget(experimentId: string, nextCap: number): Promise<void> {
    const db = this.database()
    await db.transaction("rw", db.evalExperiments, async () => {
      const experiment = await db.evalExperiments.get(experimentId)
      if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
      this.options.scope?.assertActive()
      const currentCap = experiment.budgetCap ?? experiment.manifest.budget.hardCap
      if (!Number.isFinite(nextCap) || nextCap <= currentCap) {
        throw new Error("The extended evaluation budget must be greater than the current cap")
      }
      this.options.scope?.assertActive()
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
    const db = this.database()
    const experiment = await db.evalExperiments.get(experimentId)
    if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
    const rows = await db.evalTasks.where("experimentId").equals(experimentId).toArray()
    const tasks: Partial<Record<EvalTaskState, number>> = {}
    for (const row of rows) tasks[row.state] = (tasks[row.state] ?? 0) + 1
    this.options.scope?.assertActive()
    return { experiment, tasks }
  }

  async report(experimentId: string) {
    const db = this.database()
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
