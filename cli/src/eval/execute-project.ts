import { readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  bootstrapMean,
  recommendVariants,
  selectAdaptiveRepetitions,
  type EvalCandidateEvidence,
  type EvalRecommendationResult,
  type EvalVariant,
} from "@cognia/eval-core"
import type { EvalCase, EvalSample, RepetitionVerdict, Score } from "@/types/eval/eval"
import { createPureModelEvalTarget } from "@/lib/ai/eval/targets/model"
import { deterministicScorers } from "@/lib/ai/eval/scorers"
import { safeScore } from "@/lib/ai/eval/runner"
import { repetitionVerdict } from "@/lib/ai/eval/report"
import type { CliEvalExecutionResult, CliEvalProjectDocument } from "../cli/eval-command"
import { APP_VERSION } from "@/lib/app-version"

interface CliEvalSampleRecord {
  variantId: string
  caseId: string
  repetition: number
  status: "running" | "completed" | "failed" | "interrupted"
  /**
   * The shared scorers' verdict. `ungraded` means no selected scorer could
   * grade this case — it is neither a pass nor a failure and is EXCLUDED from
   * the quality vector rather than silently counted as 1.
   */
  verdict?: RepetitionVerdict
  /** Every scorer observation, kept as run evidence for export. */
  scores?: Score[]
  /** 1 for a passing verdict, 0 otherwise. Retained for the CSV export. */
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

/**
 * The CLI grades with the SAME scorers the in-app engine uses. It previously
 * carried its own binary heuristic whose last branch returned 1 for any
 * non-empty answer — so a dataset with no reference answers scored a perfect
 * 1.0 on every case, which is exactly the failure mode `ScoreStatus` and
 * `gradedCaseCount` exist to prevent.
 */
const CLI_SCORERS = deterministicScorers()

async function scoreSample(
  sample: EvalSample,
  evalCase: EvalCase
): Promise<{ verdict: RepetitionVerdict; scores: Score[] }> {
  const scores = await Promise.all(CLI_SCORERS.map((scorer) => safeScore(scorer, sample, evalCase)))
  return { verdict: repetitionVerdict({ sample, scores }), scores }
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

/**
 * Turn the checkpoint's per-repetition verdicts into decision evidence.
 *
 * Two rules this encodes, both learned the hard way:
 *
 *  - Only GRADED repetitions enter the quality vector. An ungraded case is not
 *    a pass, so `effectiveCases` counts what was actually judged. That alone
 *    makes `recommendVariants` answer `no_conclusion` ("insufficient_cases")
 *    on a dataset carrying no references, instead of recommending a variant on
 *    the strength of a vector of 1.0s.
 *  - The interval is a single-sample mean CI, computed with {@link bootstrapMean}.
 *    It used to call `pairedBootstrap(quality, zeros)`, which dresses a mean CI
 *    as a paired comparison against a baseline that never ran. Real paired
 *    comparison needs a real baseline variant.
 *
 * Cost and latency are summed over EVERY row, graded or not — ungraded work
 * still spends money.
 */
function evidenceFor(
  variantId: string,
  samples: CliEvalSampleRecord[],
  calibrated: boolean,
  seed: number
): EvalCandidateEvidence {
  const rows = samples.filter((sample) => sample.variantId === variantId)
  const gradedByCase = new Map<string, number[]>()
  for (const row of rows) {
    if (row.verdict === undefined || row.verdict === "ungraded") continue
    const group = gradedByCase.get(row.caseId) ?? []
    group.push(row.verdict === "pass" ? 1 : 0)
    gradedByCase.set(row.caseId, group)
  }
  const quality = [...gradedByCase.values()].map(
    (group) => group.reduce((sum, value) => sum + value, 0) / group.length
  )
  const cost = rows.reduce((sum, row) => sum + row.cost, 0)
  const latency = rows.length
    ? rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length / 10_000
    : 1
  const reliability = quality.filter((value) => value === 1).length / Math.max(1, quality.length)
  const interval = quality.length ? bootstrapMean(quality, { seed, iterations: 2_000 }) : undefined
  return {
    variantId,
    effectiveCases: quality.length,
    metrics: {
      quality: quality.reduce((sum, value) => sum + value, 0) / Math.max(1, quality.length),
      reliability,
      cost,
      latency,
    },
    intervals: interval ? { quality: { low: interval.low, high: interval.high } } : {},
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
        const { verdict, scores } = await scoreSample(sample, evalCase)
        checkpoint.samples[inFlightIndex] = {
          variantId: variant.id,
          caseId: evalCase.id,
          repetition,
          status: "completed",
          verdict,
          scores,
          quality: verdict === "pass" ? 1 : 0,
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
          // A target that threw IS an agent failure, so this is a graded
          // `fail`, not `ungraded` — otherwise a variant that crashes on every
          // case reports zero effective cases and gets excluded from the
          // comparison instead of losing it.
          verdict: "fail",
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
