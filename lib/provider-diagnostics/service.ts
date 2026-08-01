import type { LanguageModel, EmbeddingModel } from "ai"
import type { FeatureCallCredentials, FeatureCallRequest } from "@cognia/agent-config-types"
import {
  clampProviderDiagnosticsBudget,
  DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES,
  type ProviderDiagnosticFailure,
  type ProviderDiagnosticJob,
  type ProviderDiagnosticSample,
  type ProviderDiagnosticSampleRole,
  type ProviderDiagnosticTarget,
  type ProviderDiagnosticsPreferences,
} from "@cognia/provider-types"

import { createSidecarEmbeddingModel, createSidecarLanguageModel } from "@/lib/claude/feature-call"

import {
  PROVIDER_DIAGNOSTIC_EMBEDDING_PROMPT_VERSION,
  PROVIDER_DIAGNOSTIC_TEXT_PROMPT_VERSION,
  type ProviderDiagnosticPrice,
  runProviderEmbeddingBenchmark,
  runProviderTextBenchmark,
} from "./benchmark"
import { runProviderProbe } from "./probe"
import { recordProviderDiagnosticJob, recordProviderDiagnosticSample } from "./store"

export interface ResolvedProviderDiagnosticTarget extends ProviderDiagnosticTarget {
  /** Ephemeral execution material. Never pass this object to persistence or companion sync. */
  credentials: FeatureCallCredentials
  protocolAdapterSpec?: FeatureCallRequest["protocolAdapterSpec"]
  price?: ProviderDiagnosticPrice
  estimatedMaxCostUsd?: number
  billable: boolean
}

export interface StartProviderDiagnosticJobInput {
  jobId?: string
  providerId: string
  mode: "quick" | "precise"
  capability: "probe" | "text-generation" | "embedding"
  targets: ResolvedProviderDiagnosticTarget[]
  unknownCostConfirmed?: boolean
  preferences?: Partial<ProviderDiagnosticsPreferences>
  remoteAudit?: ProviderDiagnosticJob["remoteAudit"]
}

interface SampleExecutionResult {
  metrics?: ProviderDiagnosticSample["metrics"]
  probe?: ProviderDiagnosticSample["probe"]
  promptVersion?: string
  pricingVersion?: string
}

interface ProviderDiagnosticServiceDependencies {
  createId?: () => string
  now?: () => number
  executeSample?: (
    target: ResolvedProviderDiagnosticTarget,
    role: ProviderDiagnosticSampleRole,
    signal: AbortSignal,
    preferences: ProviderDiagnosticsPreferences
  ) => Promise<SampleExecutionResult>
  recordJob?: typeof recordProviderDiagnosticJob
  recordSample?: typeof recordProviderDiagnosticSample
}

interface ActiveDiagnosticJob {
  controller: AbortController
  targetControllers: Map<string, AbortController>
  cancelledTargets: Set<string>
}

const activeJobs = new Map<string, ActiveDiagnosticJob>()

function createId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${suffix}`
}

function normalizeFailure(error: unknown, aborted: boolean): ProviderDiagnosticFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (aborted || /abort|cancel/i.test(message)) {
    return { code: "aborted", retryable: false, message: "Provider diagnostic was cancelled" }
  }
  if (/401|unauthori|api.?key|credential/i.test(message)) {
    return { code: "authentication", retryable: false, message }
  }
  if (/403|permission|forbidden/i.test(message)) {
    return { code: "permission", retryable: false, message }
  }
  if (/429|rate.?limit/i.test(message)) {
    return { code: "rate-limited", retryable: true, message }
  }
  if (/quota|insufficient|balance/i.test(message)) {
    return { code: "quota", retryable: false, message }
  }
  if (/timeout|timed out/i.test(message)) return { code: "timeout", retryable: true, message }
  return { code: "transport", retryable: true, message }
}

async function defaultExecuteSample(
  target: ResolvedProviderDiagnosticTarget,
  _role: ProviderDiagnosticSampleRole,
  signal: AbortSignal,
  preferences: ProviderDiagnosticsPreferences
): Promise<SampleExecutionResult> {
  if (target.capability === "probe") {
    const probe = await runProviderProbe(
      {
        providerId: target.providerId,
        protocol: target.credentials.protocol ?? "openai",
        baseURL: target.endpoint,
        apiKey: target.credentials.apiKey,
        headers: target.credentials.headers,
        model: target.modelId,
        bedrock: {
          authMode: target.credentials.bedrockAuthMode,
          region: target.credentials.region,
          accessKeyId: target.credentials.accessKeyId,
          secretAccessKey: target.credentials.secretAccessKey,
          sessionToken: target.credentials.sessionToken,
          profile: target.credentials.profile,
          roleArn: target.credentials.roleArn,
          roleSessionName: target.credentials.roleSessionName,
        },
      },
      { timeoutMs: preferences.probeTimeoutMs, signal }
    )
    if (signal.aborted) throw signal.reason
    return { probe, promptVersion: "provider-diagnostics-probe-v1" }
  }
  if (!target.modelId) throw new Error("A model is required for a paid provider diagnostic")
  if (target.capability === "embedding") {
    const model = createSidecarEmbeddingModel({
      modelId: target.modelId,
      providerId: target.providerId,
      credentials: target.credentials,
    }) as unknown as EmbeddingModel
    const result = await runProviderEmbeddingBenchmark({
      model,
      signal,
      ...(target.price
        ? {
            price: {
              inputPerMillionUsd: target.price.inputPerMillionUsd,
              version: target.price.version,
            },
          }
        : {}),
    })
    return result
  }
  const model = createSidecarLanguageModel({
    modelId: target.modelId,
    providerId: target.providerId,
    credentials: target.credentials,
    protocolAdapterSpec: target.protocolAdapterSpec,
  }) as unknown as LanguageModel
  return runProviderTextBenchmark({
    model,
    signal,
    maxOutputTokens: preferences.maxOutputTokens,
    price: target.price,
  })
}

export function cancelProviderDiagnosticJob(jobId: string): boolean {
  const runtime = activeJobs.get(jobId)
  if (!runtime) return false
  runtime.controller.abort(new DOMException("Provider diagnostic cancelled", "AbortError"))
  return true
}

export function cancelProviderDiagnosticTarget(jobId: string, targetId: string): boolean {
  const runtime = activeJobs.get(jobId)
  if (!runtime) return false
  runtime.cancelledTargets.add(targetId)
  runtime.targetControllers
    .get(targetId)
    ?.abort(new DOMException("Provider diagnostic target cancelled", "AbortError"))
  return true
}

function boundedSampleSignal(
  jobSignal: AbortSignal,
  targetSignal: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason)
  const onJobAbort = forward(jobSignal)
  const onTargetAbort = forward(targetSignal)
  jobSignal.addEventListener("abort", onJobAbort, { once: true })
  targetSignal.addEventListener("abort", onTargetAbort, { once: true })
  if (jobSignal.aborted) onJobAbort()
  else if (targetSignal.aborted) onTargetAbort()
  const timer = setTimeout(
    () => {
      controller.abort(new DOMException("Provider diagnostic sample timed out", "TimeoutError"))
    },
    Math.max(1, timeoutMs)
  )
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      jobSignal.removeEventListener("abort", onJobAbort)
      targetSignal.removeEventListener("abort", onTargetAbort)
    },
  }
}

export async function startProviderDiagnosticJob(
  input: StartProviderDiagnosticJobInput,
  dependencies: ProviderDiagnosticServiceDependencies = {}
): Promise<ProviderDiagnosticJob> {
  // Clamped, not merged: `input.preferences` reaches here from settings rows a
  // restore or an import can write, so a supplied budget is a *request* for a
  // smaller one. Raising the ADR-0104 ceiling is not a thing a caller can do.
  const preferences: ProviderDiagnosticsPreferences = clampProviderDiagnosticsBudget({
    ...DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES,
    ...input.preferences,
  })
  const roles: ProviderDiagnosticSampleRole[] =
    input.mode === "precise" ? ["warmup", "measured", "measured", "measured"] : ["measured"]
  const requestCount = input.targets.length * roles.length
  if (requestCount > preferences.maxRequestsPerJob) {
    throw new Error(
      `Provider diagnostic exceeds the ${preferences.maxRequestsPerJob} request limit`
    )
  }
  const unknownCost = input.targets.some(
    (target) => target.billable && target.estimatedMaxCostUsd === undefined
  )
  if (unknownCost && !input.unknownCostConfirmed) {
    throw new Error("Provider diagnostic cost is unknown and requires explicit confirmation")
  }
  const estimatedCost = input.targets.reduce(
    (total, target) => total + (target.estimatedMaxCostUsd ?? 0) * roles.length,
    0
  )
  if (estimatedCost > preferences.maxEstimatedCostUsd) {
    throw new Error(
      `Provider diagnostic exceeds the ${preferences.maxEstimatedCostUsd} USD estimated cost limit`
    )
  }

  const makeId = dependencies.createId ?? (() => createId("provider-diagnostic"))
  const now = dependencies.now ?? Date.now
  const jobId = input.jobId ?? makeId()
  if (activeJobs.has(jobId)) throw new Error(`Provider diagnostic job ${jobId} is already running`)
  const controller = new AbortController()
  const runtime: ActiveDiagnosticJob = {
    controller,
    targetControllers: new Map(),
    cancelledTargets: new Set(),
  }
  activeJobs.set(jobId, runtime)
  const recordJob = dependencies.recordJob ?? recordProviderDiagnosticJob
  const recordSample = dependencies.recordSample ?? recordProviderDiagnosticSample
  const executeSample = dependencies.executeSample ?? defaultExecuteSample
  const startedAt = now()
  const job: ProviderDiagnosticJob = {
    id: jobId,
    providerId: input.providerId,
    mode: input.mode,
    capability: input.capability,
    status: "running",
    targetCount: input.targets.length,
    completedCount: 0,
    requestLimit: preferences.maxRequestsPerJob,
    maxEstimatedCostUsd: preferences.maxEstimatedCostUsd,
    estimatedCostUsd: 0,
    startedAt,
    ...(input.remoteAudit ? { remoteAudit: input.remoteAudit } : {}),
  }
  await recordJob(job)

  let nextTarget = 0
  async function worker(): Promise<void> {
    while (!controller.signal.aborted) {
      const index = nextTarget
      nextTarget += 1
      const target = input.targets[index]
      if (!target) return
      const targetController = new AbortController()
      runtime.targetControllers.set(target.id, targetController)
      for (const role of roles) {
        if (controller.signal.aborted) return
        if (runtime.cancelledTargets.has(target.id)) break
        const sampleStartedAt = now()
        let sample: ProviderDiagnosticSample
        const timeoutMs =
          target.capability === "probe"
            ? preferences.probeTimeoutMs
            : target.capability === "embedding"
              ? preferences.embeddingTimeoutMs
              : preferences.textTimeoutMs
        const bounded = boundedSampleSignal(controller.signal, targetController.signal, timeoutMs)
        try {
          const result = await executeSample(target, role, bounded.signal, preferences)
          const completedAt = now()
          const probeFailed = result.probe?.failure
          sample = {
            id: makeId(),
            jobId,
            targetId: target.id,
            providerId: target.providerId,
            modelId: target.modelId,
            credentialFingerprint: target.credentialFingerprint,
            endpoint: target.endpoint,
            capability: target.capability,
            promptVersion:
              result.promptVersion ??
              (target.capability === "embedding"
                ? PROVIDER_DIAGNOSTIC_EMBEDDING_PROMPT_VERSION
                : PROVIDER_DIAGNOSTIC_TEXT_PROMPT_VERSION),
            sampleRole: role,
            status: probeFailed ? "failed" : "completed",
            startedAt: sampleStartedAt,
            completedAt,
            probe: result.probe,
            metrics: result.metrics,
            failure: probeFailed,
            pricingVersion: result.pricingVersion,
          }
        } catch (error) {
          const cancelled = controller.signal.aborted || targetController.signal.aborted
          sample = {
            id: makeId(),
            jobId,
            targetId: target.id,
            providerId: target.providerId,
            modelId: target.modelId,
            credentialFingerprint: target.credentialFingerprint,
            endpoint: target.endpoint,
            capability: target.capability,
            promptVersion:
              target.capability === "embedding"
                ? PROVIDER_DIAGNOSTIC_EMBEDDING_PROMPT_VERSION
                : PROVIDER_DIAGNOSTIC_TEXT_PROMPT_VERSION,
            sampleRole: role,
            status: cancelled ? "cancelled" : "failed",
            startedAt: sampleStartedAt,
            completedAt: now(),
            failure: normalizeFailure(error, cancelled),
          }
        } finally {
          bounded.cleanup()
        }
        await recordSample(sample)
        job.completedCount += 1
        job.estimatedCostUsd = (job.estimatedCostUsd ?? 0) + (sample.metrics?.estimatedCostUsd ?? 0)
        if ((job.estimatedCostUsd ?? 0) > preferences.maxEstimatedCostUsd) {
          controller.abort(new DOMException("Provider diagnostic cost limit reached", "AbortError"))
        }
        await recordJob({ ...job })
        if (sample.status === "cancelled") {
          if (controller.signal.aborted) return
          break
        }
      }
      runtime.targetControllers.delete(target.id)
    }
  }

  try {
    const concurrency = Math.min(5, Math.max(1, preferences.concurrency))
    await Promise.all(Array.from({ length: Math.min(concurrency, input.targets.length) }, worker))
    job.status = controller.signal.aborted ? "cancelled" : "completed"
    job.completedAt = now()
    if (job.remoteAudit) job.remoteAudit.outcome = job.status
    if (controller.signal.aborted) job.cancelledAt = job.completedAt
    await recordJob(job)
    return job
  } finally {
    activeJobs.delete(jobId)
  }
}
