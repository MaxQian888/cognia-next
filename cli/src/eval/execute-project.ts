import { readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  pairedBootstrap,
  recommendVariants,
  selectAdaptiveRepetitions,
  type EvalCandidateEvidence,
  type EvalRecommendationResult,
  type EvalVariant,
} from "@cognia/eval-core"
import type { EvalCase, EvalSample } from "@/types/eval/eval"
import { createPureModelEvalTarget } from "@/lib/ai/eval/targets/model"
import type { CliEvalExecutionResult, CliEvalProjectDocument } from "../cli/eval-command"
import { APP_VERSION } from "@/lib/app-version"

interface CliEvalSampleRecord {
  variantId: string
  caseId: string
  repetition: number
  status: "running" | "completed" | "failed" | "interrupted"
  quality: number
  cost: number
  latencyMs: number
  output?: string
  error?: string
  redactionPolicy?: EvalSample["redactionPolicy"]
  redactionDigest?: string
}

export interface CliEvalCheckpoint {
  schema: "cognia-eval-checkpoint/v1"
  projectId: string
  status: "running" | "paused" | "interrupted" | "completed" | "failed" | "cancelled"
  outcome?: "recommended" | "no_conclusion"
  recommendation?: EvalRecommendationResult
  spentCost: number
  hardCap: number
  completedTasks: number
  totalTasks: number
  samples: CliEvalSampleRecord[]
  error?: string
  updatedAt: string
  portableProject?: {
    name: string
    mode: "model" | "agent"
    datasetDigest: string
    variants: Array<{ id: string; name: string; providerId?: string; modelId?: string }>
    appVersion: string
    randomSeed: number
  }
}

async function loadCheckpoint(
  pathname: string,
  projectId: string
): Promise<CliEvalCheckpoint | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(pathname), "utf8")) as CliEvalCheckpoint
    if (parsed.schema !== "cognia-eval-checkpoint/v1") {
      throw new Error("Unsupported evaluation checkpoint schema")
    }
    if (parsed.projectId !== projectId) {
      throw new Error("Evaluation checkpoint belongs to a different project")
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function environmentName(providerId: string, suffix: "API_KEY" | "BASE_URL"): string {
  return `COGNIA_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`
}

function providerSettings(variant: EvalVariant) {
  const providerId = variant.providerId ?? ""
  return {
    defaultProvider: providerId,
    providerSettings: {
      [providerId]: {
        enabled: true,
        apiKey: process.env[environmentName(providerId, "API_KEY")],
        baseURL: process.env[environmentName(providerId, "BASE_URL")],
        defaultModel: variant.modelId,
      },
    },
    customProviders: [],
  }
}

function qualityScore(sample: EvalSample, evalCase: EvalCase): number {
  if (sample.error || !sample.output.trim()) return 0
  const expected = evalCase.reference?.expectedOutput
  if (expected !== undefined) {
    return sample.output.trim().toLocaleLowerCase() === expected.trim().toLocaleLowerCase() ? 1 : 0
  }
  const contains = evalCase.reference?.expectedContains
  if (contains?.length) {
    const normalized = sample.output.toLocaleLowerCase()
    return contains.every((value) => normalized.includes(value.toLocaleLowerCase())) ? 1 : 0
  }
  return 1
}

function worstCaseCost(variant: EvalVariant, evalCase: EvalCase): number {
  if (variant.isLocal || !variant.price) return 0
  const inputTokens = Math.ceil(evalCase.input.length / 4)
  const outputTokens = Number(variant.parameters?.maxOutputTokens ?? 4096)
  return (
    (inputTokens * variant.price.inputPerMillion + outputTokens * variant.price.outputPerMillion) /
    1_000_000
  )
}

async function persistCheckpoint(pathname: string, checkpoint: CliEvalCheckpoint): Promise<void> {
  const target = path.resolve(pathname)
  const temporary = `${target}.task-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8")
  await rename(temporary, target)
}

function evidenceFor(
  variantId: string,
  samples: CliEvalSampleRecord[],
  calibrated: boolean,
  seed: number
): EvalCandidateEvidence {
  const rows = samples.filter((sample) => sample.variantId === variantId)
  const latestByCase = new Map<string, CliEvalSampleRecord[]>()
  for (const row of rows) {
    const group = latestByCase.get(row.caseId) ?? []
    group.push(row)
    latestByCase.set(row.caseId, group)
  }
  const quality = [...latestByCase.values()].map(
    (group) => group.reduce((sum, row) => sum + row.quality, 0) / group.length
  )
  const cost = rows.reduce((sum, row) => sum + row.cost, 0)
  const latency = rows.length
    ? rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length / 10_000
    : 1
  const reliability = quality.filter((value) => value === 1).length / Math.max(1, quality.length)
  const interval = pairedBootstrap(
    quality,
    quality.map(() => 0),
    {
      seed,
      iterations: 2_000,
    }
  )
  return {
    variantId,
    effectiveCases: quality.length,
    metrics: {
      quality: quality.reduce((sum, value) => sum + value, 0) / Math.max(1, quality.length),
      reliability,
      cost,
      latency,
    },
    intervals: { quality: { low: interval.low, high: interval.high } },
    calibrationPassed: calibrated,
  }
}

function asCases(value: unknown[] | undefined): EvalCase[] {
  if (!value?.length) throw new Error("CLI evaluation project must embed a non-empty cases array")
  return value as EvalCase[]
}

export async function executeCliEvalProject(
  document: CliEvalProjectDocument,
  checkpointPath: string
): Promise<CliEvalExecutionResult> {
  const { project } = document
  const cases = asCases(document.cases)
  if (project.mode !== "model") {
    throw new Error("CLI execution supports pure-model projects; Agent projects run on desktop")
  }
  const variants = project.variants.filter((variant) => variant.kind === "model")
  const restored = await loadCheckpoint(checkpointPath, project.id)
  if (restored?.status === "completed" || restored?.status === "cancelled") {
    return {
      exitCode: restored.status === "cancelled" ? 130 : restored.outcome === "recommended" ? 0 : 2,
      checkpoint: restored,
    }
  }
  if (
    restored?.status === "interrupted" ||
    restored?.samples.some((sample) => sample.status === "running")
  ) {
    restored.status = "interrupted"
    restored.samples = restored.samples.map((sample) =>
      sample.status === "running"
        ? {
            ...sample,
            status: "interrupted",
            error:
              "Provider outcome is ambiguous after process interruption; task was not replayed",
          }
        : sample
    )
    restored.updatedAt = new Date().toISOString()
    await persistCheckpoint(checkpointPath, restored)
    return { exitCode: 1, checkpoint: restored }
  }
  const checkpoint: CliEvalCheckpoint = restored ?? {
    schema: "cognia-eval-checkpoint/v1",
    projectId: project.id,
    status: "running",
    spentCost: 0,
    hardCap: project.budget.hardCap,
    completedTasks: 0,
    totalTasks: variants.length * cases.length,
    samples: [],
    updatedAt: new Date().toISOString(),
    portableProject: {
      name: project.name,
      mode: project.mode,
      datasetDigest: project.dataset.digest,
      variants: project.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        ...(variant.providerId ? { providerId: variant.providerId } : {}),
        ...(variant.modelId ? { modelId: variant.modelId } : {}),
      })),
      appVersion: APP_VERSION,
      randomSeed: project.updatedAt >>> 0,
    },
  }
  checkpoint.status = "running"
  checkpoint.hardCap = project.budget.hardCap
  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.once("SIGINT", onInterrupt)

  const executeRepetition = async (variant: EvalVariant, repetition: number) => {
    const target = createPureModelEvalTarget({
      label: variant.name,
      providerId: variant.providerId ?? "",
      modelId: variant.modelId ?? "",
      isLocal: variant.isLocal,
      price: variant.price,
      parameters: variant.parameters as never,
      settings: providerSettings(variant),
    })
    for (const evalCase of cases) {
      if (
        checkpoint.samples.some(
          (sample) =>
            sample.variantId === variant.id &&
            sample.caseId === evalCase.id &&
            sample.repetition === repetition
        )
      ) {
        continue
      }
      if (controller.signal.aborted) return
      const reservation = worstCaseCost(variant, evalCase)
      if (checkpoint.spentCost + reservation > checkpoint.hardCap) {
        checkpoint.status = "paused"
        checkpoint.updatedAt = new Date().toISOString()
        await persistCheckpoint(checkpointPath, checkpoint)
        return
      }
      try {
        const inFlightIndex =
          checkpoint.samples.push({
            variantId: variant.id,
            caseId: evalCase.id,
            repetition,
            status: "running",
            quality: 0,
            cost: 0,
            latencyMs: 0,
          }) - 1
        checkpoint.updatedAt = new Date().toISOString()
        await persistCheckpoint(checkpointPath, checkpoint)
        const sample = await target.run(evalCase, controller.signal)
        checkpoint.spentCost += sample.costUsd
        checkpoint.samples[inFlightIndex] = {
          variantId: variant.id,
          caseId: evalCase.id,
          repetition,
          status: "completed",
          quality: qualityScore(sample, evalCase),
          cost: sample.costUsd,
          latencyMs: sample.latencyMs,
          output: sample.output,
          redactionPolicy: sample.redactionPolicy,
          redactionDigest: sample.redactionDigest,
        }
      } catch (error) {
        const inFlightIndex = checkpoint.samples.findIndex(
          (sample) =>
            sample.variantId === variant.id &&
            sample.caseId === evalCase.id &&
            sample.repetition === repetition &&
            sample.status === "running"
        )
        const failed: CliEvalSampleRecord = {
          variantId: variant.id,
          caseId: evalCase.id,
          repetition,
          status: "failed",
          quality: 0,
          cost: 0,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error),
        }
        if (inFlightIndex >= 0) checkpoint.samples[inFlightIndex] = failed
        else checkpoint.samples.push(failed)
      }
      checkpoint.completedTasks++
      checkpoint.updatedAt = new Date().toISOString()
      await persistCheckpoint(checkpointPath, checkpoint)
    }
  }

  try {
    const isPaused = () => checkpoint.status === "paused"
    for (const variant of variants) {
      await executeRepetition(variant, 1)
      if (isPaused() || controller.signal.aborted) break
    }
    if (controller.signal.aborted) {
      checkpoint.status = "cancelled"
      checkpoint.updatedAt = new Date().toISOString()
      return { exitCode: 130, checkpoint }
    }
    if (isPaused()) return { exitCode: 2, checkpoint }

    const initialEvidence = variants.map((variant, index) =>
      evidenceFor(
        variant.id,
        checkpoint.samples,
        !project.decisionPolicy.formal || project.judgePolicy.calibrated,
        index + 1
      )
    )
    const adaptive = selectAdaptiveRepetitions(
      initialEvidence.map((candidate) => ({
        variantId: candidate.variantId,
        repetitions: 1,
        constraintMargins: project.decisionPolicy.constraints.map(
          (constraint) => (candidate.metrics[constraint.metric] ?? 0) - constraint.value
        ),
        rankingInterval: [
          candidate.intervals.quality?.low ?? 0,
          candidate.intervals.quality?.high ?? 1,
        ] as [number, number],
      })),
      { boundaryMargin: 0.05 }
    )
    checkpoint.totalTasks = Math.max(
      checkpoint.totalTasks,
      variants.length * cases.length + adaptive.length * cases.length * 2
    )
    for (const item of adaptive) {
      const variant = variants.find((candidate) => candidate.id === item.variantId)
      if (!variant) continue
      await executeRepetition(variant, 2)
      if (isPaused() || controller.signal.aborted) break
      await executeRepetition(variant, 3)
      if (isPaused() || controller.signal.aborted) break
    }
    if (controller.signal.aborted) {
      checkpoint.status = "cancelled"
      return { exitCode: 130, checkpoint }
    }
    if (isPaused()) return { exitCode: 2, checkpoint }

    const evidence = variants.map((variant, index) =>
      evidenceFor(
        variant.id,
        checkpoint.samples,
        !project.decisionPolicy.formal || project.judgePolicy.calibrated,
        index + 101
      )
    )
    checkpoint.recommendation = recommendVariants(project.decisionPolicy, evidence)
    checkpoint.outcome = checkpoint.recommendation.status
    checkpoint.status = "completed"
    checkpoint.updatedAt = new Date().toISOString()
    return {
      exitCode: checkpoint.outcome === "recommended" ? 0 : 2,
      checkpoint,
    }
  } catch (error) {
    checkpoint.status = "failed"
    checkpoint.error = error instanceof Error ? error.message : String(error)
    checkpoint.updatedAt = new Date().toISOString()
    return { exitCode: 1, checkpoint }
  } finally {
    process.off("SIGINT", onInterrupt)
  }
}
