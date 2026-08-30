import type { AppSettings } from "@cognia/agent-config-types"
import type {
  EvalExperimentManifest,
  EvalExperimentState,
  EvalTask,
  EvalVariant,
} from "@cognia/eval-core"
import type { EvalCase, EvalSample, Score, Scorer } from "@/types/eval/eval"
import type { TargetSpec } from "@/types/eval/run-config"
import {
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type RichCustomProviderEntry,
} from "@/lib/ai/provider-consumption"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { applyPiiGate } from "@/lib/workflow/nodes/ai/pii-gate"
import {
  completeEvalTask,
  type EvalExperimentRow,
  type EvalSampleRow,
  type EvalScoreRow,
} from "@/lib/db/eval-lab"
import { getCase } from "@/lib/db/eval-datasets"
import { getDb } from "@/lib/db/schema"
import { decryptEvalArtifact, encryptEvalArtifact } from "./artifact-crypto"
import {
  DurableEvalOrchestrator,
  type EvalOrchestratorOptions,
  type EvalOrchestratorRepository,
  type EvalTaskExecutionResult,
} from "./orchestrator"
import { deterministicScorers, llmScorers } from "@cognia/eval-core"
import { prepareNextEvalStage } from "./finalization"
import type { EvalTarget } from "@cognia/eval-core"
import { createTargetFromSpec } from "./targets/create-from-spec"
import { defaultChatTargetDeps } from "./targets/chat"
import { createPureModelEvalTarget } from "./targets/model"
import { defaultTeamTargetDeps } from "./targets/team-default-deps"
import { defaultWorkflowTargetDeps } from "./targets/workflow-default-deps"
import { isConfirmedLocalProvider } from "./provider-locality"

const DAY_MS = 24 * 60 * 60 * 1_000
const TARGET_PART_SEPARATOR = "\u001eCOGNIA_EVAL_TARGET_PART\u001e"

export interface EvalExecutedTaskArtifacts {
  sample: EvalSampleRow
  scores: EvalScoreRow[]
}

export class DexieEvalOrchestratorRepository implements EvalOrchestratorRepository<EvalExecutedTaskArtifacts> {
  constructor(private readonly artifactKey?: Uint8Array) {}
  async getExperiment(
    id: string
  ): Promise<{ state: EvalExperimentState; hardCap: number } | undefined> {
    const experiment = await getDb().evalExperiments.get(id)
    return experiment
      ? {
          state: experiment.state,
          hardCap: experiment.budgetCap ?? experiment.manifest.budget.hardCap,
        }
      : undefined
  }

  listTasks(experimentId: string) {
    return getDb().evalTasks.where("experimentId").equals(experimentId).toArray()
  }

  async setExperimentState(
    id: string,
    state: EvalExperimentState,
    details: { pauseReason?: "user" | "budget" | "rate-limit" | "recovery"; failure?: string } = {}
  ): Promise<void> {
    await getDb().evalExperiments.update(id, {
      state,
      pauseReason: details.pauseReason,
      failure: details.failure,
      updatedAt: Date.now(),
    })
  }

  async updateTask(id: string, patch: Partial<EvalTask> & { lastError?: string }): Promise<void> {
    await getDb().evalTasks.update(id, patch)
  }

  async reserveTask(taskId: string, worstCaseCost: number): Promise<boolean> {
    const db = getDb()
    return db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
      const task = await db.evalTasks.get(taskId)
      if (!task || task.state !== "queued") return false
      const experiment = await db.evalExperiments.get(task.experimentId)
      if (!experiment || experiment.state === "paused" || experiment.state === "cancelled") {
        return false
      }
      const reservation = Math.max(0, worstCaseCost)
      const reservationDelta = Math.max(0, reservation - task.reservedCost)
      if (
        experiment.spentCost + experiment.reservedCost + reservationDelta >
        (experiment.budgetCap ?? experiment.manifest.budget.hardCap)
      ) {
        return false
      }
      await db.evalTasks.update(taskId, { reservedCost: reservation, updatedAt: Date.now() })
      await db.evalExperiments.update(experiment.id, {
        reservedCost: experiment.reservedCost + reservationDelta,
        updatedAt: Date.now(),
      })
      return true
    })
  }

  async completeTask(
    task: EvalTask,
    result: EvalTaskExecutionResult<EvalExecutedTaskArtifacts>
  ): Promise<void> {
    await completeEvalTask({ task, sample: result.value.sample, scores: result.value.scores })
  }

  async releaseTaskReservation(taskId: string): Promise<void> {
    const db = getDb()
    await db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
      const task = await db.evalTasks.get(taskId)
      if (!task || task.reservedCost <= 0) return
      const experiment = await db.evalExperiments.get(task.experimentId)
      await db.evalTasks.update(taskId, { reservedCost: 0, updatedAt: Date.now() })
      if (experiment) {
        await db.evalExperiments.update(experiment.id, {
          reservedCost: Math.max(0, experiment.reservedCost - task.reservedCost),
          updatedAt: Date.now(),
        })
      }
    })
  }

  prepareNextStage(experimentId: string): Promise<boolean> {
    return prepareNextEvalStage(experimentId, { artifactKey: this.artifactKey })
  }
}

interface BuildTargetInput {
  manifest: EvalExperimentManifest
  variant: EvalVariant
  appSettings: AppSettings
  artifactKey: Uint8Array
  confirmedLocal: boolean
}

export interface BrowserEvalExecutorDependencies {
  loadExperiment(id: string): Promise<EvalExperimentRow | undefined>
  loadCase(id: string): Promise<EvalCase | undefined>
  buildTarget(input: BuildTargetInput): EvalTarget
  resolveScorers(
    manifest: EvalExperimentManifest,
    appSettings: AppSettings
  ): Scorer[] | ResolvedEvalScorers
  encryptArtifact: typeof encryptEvalArtifact
  now(): number
  newId(): string
}

interface JudgeUsage {
  inputTokens: number
  outputTokens: number
}

interface ResolvedEvalScorers {
  scorers: Scorer[]
  getJudgeAccounting?: () => JudgeUsage & { cost: number }
}

export interface BrowserEvalExecutorOptions {
  appSettings: AppSettings
  artifactKey: Uint8Array
}

function providerSnapshotInput(appSettings: AppSettings) {
  return {
    defaultProvider: appSettings.defaultProvider,
    providerSettings: appSettings.providerSettings as
      Record<string, ProviderSettingsEntry> | undefined,
    customProviders: appSettings.customProviders as RichCustomProviderEntry[] | undefined,
  }
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required for this evaluation variant`)
  return value
}

function agentTargetSpec(variant: EvalVariant): TargetSpec {
  if (variant.kind === "chat") {
    return {
      kind: "chat",
      label: variant.name,
      providerId: required(variant.providerId, "Provider id"),
      model: required(variant.modelId, "Model id"),
      ...(variant.targetId ? { characterId: variant.targetId } : {}),
    }
  }
  if (variant.kind === "team") {
    return {
      kind: "team",
      label: variant.name,
      teamId: required(variant.targetId, "Team id"),
    }
  }
  if (variant.kind === "workflow") {
    return {
      kind: "workflow",
      label: variant.name,
      workflowId: required(variant.targetId, "Workflow id"),
    }
  }
  throw new Error(`Variant ${variant.id} is not an Agent target`)
}

async function artifactResolver(
  artifactKey: Uint8Array,
  assetId: string,
  requireCloudClearance: boolean
) {
  const asset = await getDb().evalAssets.get(assetId)
  if (!asset) throw new Error(`Evaluation asset ${assetId} is unavailable`)
  if (
    requireCloudClearance &&
    (!asset.clearance || asset.clearance.contentDigest !== asset.digest)
  ) {
    throw new Error(`Evaluation asset ${assetId} has no verified cloud-media clearance`)
  }
  const decrypted = await decryptEvalArtifact<{ data: string; mediaType?: string }>(
    artifactKey,
    asset.encryptedBytes
  )
  return { data: decrypted.data, mediaType: decrypted.mediaType ?? asset.mediaType }
}

function defaultBuildTarget({
  variant,
  appSettings,
  artifactKey,
  confirmedLocal,
}: BuildTargetInput): EvalTarget {
  if (variant.kind !== "model") {
    return createTargetFromSpec(agentTargetSpec(variant), {
      chat: {
        ...defaultChatTargetDeps(),
        resolveAsset: (assetId) => artifactResolver(artifactKey, assetId, !confirmedLocal),
      },
      team: defaultTeamTargetDeps(),
      workflow: defaultWorkflowTargetDeps(),
    })
  }
  return createPureModelEvalTarget(
    {
      label: variant.name,
      providerId: required(variant.providerId, "Provider id"),
      modelId: required(variant.modelId, "Model id"),
      isLocal: confirmedLocal,
      ...(variant.price ? { price: variant.price } : {}),
      settings: providerSnapshotInput(appSettings),
      ...(typeof variant.parameters?.systemPrompt === "string"
        ? { systemPrompt: variant.parameters.systemPrompt }
        : {}),
      parameters: {
        ...(typeof variant.parameters?.temperature === "number"
          ? { temperature: variant.parameters.temperature }
          : {}),
        ...(typeof variant.parameters?.topP === "number" ? { topP: variant.parameters.topP } : {}),
        ...(typeof variant.parameters?.maxOutputTokens === "number"
          ? { maxOutputTokens: variant.parameters.maxOutputTokens }
          : {}),
      },
    },
    {
      createSnapshot: createProviderSettingsSnapshot,
      resolveProvider: resolveFeatureProvider,
      createModel: createFeatureProviderModel,
      resolveAsset: (assetId) => artifactResolver(artifactKey, assetId, !confirmedLocal),
    }
  )
}

async function digestTargetPayload(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}

async function prepareAgentTargetCase(
  evalCase: EvalCase,
  variant: EvalVariant,
  confirmedLocal: boolean
): Promise<{
  evalCase: EvalCase
  policy: NonNullable<EvalSample["redactionPolicy"]>
  digest: string
}> {
  const assetParts = (evalCase.contentParts ?? []).filter((part) => part.type === "asset")
  if (variant.kind !== "chat" && assetParts.length > 0) {
    throw new Error(`${variant.kind} evaluation targets do not accept attachment content`)
  }
  if (!confirmedLocal && assetParts.some((part) => part.privacy === "local-only")) {
    throw new Error("Cloud evaluation media requires privacy clearance")
  }
  const textSegments = [
    evalCase.input,
    ...(evalCase.history ?? []).map((turn) => turn.content),
    ...(evalCase.contentParts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
    ...(evalCase.inputVars ? [JSON.stringify(evalCase.inputVars)] : []),
  ]
  const gated = confirmedLocal
    ? textSegments
    : applyPiiGate("redact", { user: textSegments.join(TARGET_PART_SEPARATOR) }).user.split(
        TARGET_PART_SEPARATOR
      )
  let cursor = 0
  const input = gated[cursor++] ?? ""
  const history = (evalCase.history ?? []).map((turn) => ({
    ...turn,
    content: gated[cursor++] ?? "",
  }))
  const contentParts = (evalCase.contentParts ?? []).map((part) =>
    part.type === "text" ? { ...part, text: gated[cursor++] ?? "" } : part
  )
  const inputVars = evalCase.inputVars
    ? (JSON.parse(gated[cursor++] ?? "{}") as Record<string, unknown>)
    : undefined
  const prepared: EvalCase = {
    ...evalCase,
    input,
    ...(evalCase.history ? { history } : {}),
    ...(evalCase.contentParts ? { contentParts } : {}),
    ...(inputVars ? { inputVars } : {}),
  }
  return {
    evalCase: prepared,
    policy: confirmedLocal ? "local-original" : "cloud-redacted",
    digest: await digestTargetPayload({
      input,
      history,
      contentParts,
      inputVars,
    }),
  }
}

function confirmedVariantLocality(variant: EvalVariant, appSettings: AppSettings): boolean {
  if ((variant.kind !== "model" && variant.kind !== "chat") || !variant.providerId) return false
  const resolution = resolveFeatureProvider(
    {
      featureId: "eval.locality",
      routeProfile: "capability-bound",
      selectionMode: "explicit-provider",
      providerId: variant.providerId,
      fallbackMode: "none",
      executionMode: "direct-model",
      proxyMode: "never",
    },
    createProviderSettingsSnapshot(providerSnapshotInput(appSettings))
  )
  return resolution.kind === "resolved" && isConfirmedLocalProvider(resolution)
}

function defaultResolveScorers(
  manifest: EvalExperimentManifest,
  appSettings: AppSettings
): Scorer[] | ResolvedEvalScorers {
  const scorers = deterministicScorers()
  if (!manifest.judgePolicy.enabled) return scorers
  const client = buildRendererLlmClient({
    session: null,
    appSettings,
    featureId: "eval-judge",
    providerOverride: manifest.judgePolicy.providerId,
    modelOverride: manifest.judgePolicy.modelId,
  })
  if (!client) throw new Error("The configured independent evaluation judge is unavailable")
  const secondClient =
    manifest.judgePolicy.secondJudgeProviderId && manifest.judgePolicy.secondJudgeModelId
      ? buildRendererLlmClient({
          session: null,
          appSettings,
          featureId: "eval-second-judge",
          providerOverride: manifest.judgePolicy.secondJudgeProviderId,
          modelOverride: manifest.judgePolicy.secondJudgeModelId,
        })
      : undefined
  if (
    manifest.decisionPolicy.formal &&
    manifest.judgePolicy.secondJudgeProviderId &&
    !secondClient
  ) {
    throw new Error("The configured second evaluation judge is unavailable")
  }
  const primaryScorers = llmScorers({ client })
  const secondaryScorers = secondClient ? llmScorers({ client: secondClient }) : []
  const escalatedScorers = primaryScorers.map((primary, index): Scorer => {
    const secondary = secondaryScorers[index]
    if (!secondary) return primary
    return {
      ...primary,
      async score(sample, evalCase) {
        const [first, second] = await Promise.all([
          primary.score(sample, evalCase),
          secondary.score(sample, evalCase),
        ])
        if (first.status === "errored" && second.status === "errored") {
          return {
            ...first,
            error: `primary: ${first.error ?? "malformed"}; second: ${second.error ?? "malformed"}`,
          }
        }
        if (first.status === "errored") {
          return {
            ...second,
            scorerId: primary.id,
            metadata: { ...second.metadata, escalatedFrom: "primary-error" },
          }
        }
        if (second.status === "errored") {
          return {
            ...first,
            metadata: { ...first.metadata, secondJudgeError: second.error ?? "malformed" },
          }
        }
        if (first.value !== second.value || first.passed !== second.passed) {
          return {
            scorerId: primary.id,
            dimension: primary.dimension,
            status: "errored",
            value: 0,
            passed: false,
            error: "Independent judges produced conflicting verdicts; human review required",
            metadata: { primaryValue: first.value, secondValue: second.value },
          }
        }
        return {
          ...first,
          metadata: { ...first.metadata, secondJudgeAgreement: true },
        }
      },
    }
  })
  const accountingFor = (
    judgeClient: NonNullable<typeof client>,
    local: boolean | undefined,
    price: EvalExperimentManifest["judgePolicy"]["price"]
  ) => {
    const usage = judgeClient.getUsageSnapshot?.()
    const inputTokens = usage?.inputTokens ?? 0
    const outputTokens = usage?.outputTokens ?? 0
    return {
      inputTokens,
      outputTokens,
      cost:
        local || !price
          ? 0
          : (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) /
            1_000_000,
    }
  }
  return {
    scorers: [...scorers, ...escalatedScorers],
    getJudgeAccounting: () => {
      const primary = accountingFor(
        client,
        manifest.judgePolicy.isLocal,
        manifest.judgePolicy.price
      )
      const secondary = secondClient
        ? accountingFor(
            secondClient,
            manifest.judgePolicy.secondJudgeIsLocal,
            manifest.judgePolicy.secondJudgePrice
          )
        : { inputTokens: 0, outputTokens: 0, cost: 0 }
      return {
        inputTokens: primary.inputTokens + secondary.inputTokens,
        outputTokens: primary.outputTokens + secondary.outputTokens,
        cost: primary.cost + secondary.cost,
      }
    },
  }
}

function errorScore(scorer: Scorer, error: unknown): Score {
  return {
    scorerId: scorer.id,
    dimension: scorer.dimension,
    status: "errored",
    value: 0,
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  }
}

function redactJudgeEvidence(
  evalCase: EvalCase,
  sample: EvalSample
): {
  evalCase: EvalCase
  sample: EvalSample
} {
  const payload = applyPiiGate("redact", {
    user: JSON.stringify({
      input: evalCase.input,
      history: evalCase.history,
      reference: evalCase.reference,
      output: sample.output,
      retrievedChunks: sample.retrievedChunks,
    }),
  })
  const redacted = JSON.parse(payload.user) as {
    input: string
    history?: EvalCase["history"]
    reference?: EvalCase["reference"]
    output: string
    retrievedChunks?: EvalSample["retrievedChunks"]
  }
  return {
    evalCase: {
      ...evalCase,
      input: redacted.input,
      ...(redacted.history ? { history: redacted.history } : {}),
      ...(redacted.reference ? { reference: redacted.reference } : {}),
    },
    sample: {
      ...sample,
      output: redacted.output,
      retrievedChunks: redacted.retrievedChunks ?? [],
    },
  }
}

export function createBrowserEvalTaskExecutor(
  options: BrowserEvalExecutorOptions,
  overrides: Partial<BrowserEvalExecutorDependencies> = {}
): (
  task: EvalTask & { providerId?: string },
  signal: AbortSignal
) => Promise<EvalTaskExecutionResult<EvalExecutedTaskArtifacts>> {
  const dependencies: BrowserEvalExecutorDependencies = {
    loadExperiment: (id) => getDb().evalExperiments.get(id),
    loadCase: getCase,
    buildTarget: defaultBuildTarget,
    resolveScorers: defaultResolveScorers,
    encryptArtifact: encryptEvalArtifact,
    now: Date.now,
    newId: () => crypto.randomUUID(),
    ...overrides,
  }

  return async (task, signal) => {
    const experiment = await dependencies.loadExperiment(task.experimentId)
    if (!experiment) throw new Error(`Evaluation experiment ${task.experimentId} not found`)
    const variant = experiment.manifest.variants.find((item) => item.id === task.variantId)
    if (!variant) throw new Error(`Evaluation variant ${task.variantId} not found in manifest`)
    const evalCase = await dependencies.loadCase(task.caseId)
    if (!evalCase) throw new Error(`Evaluation case ${task.caseId} not found`)
    const confirmedLocal = confirmedVariantLocality(variant, options.appSettings)
    const target = dependencies.buildTarget({
      manifest: experiment.manifest,
      variant,
      appSettings: options.appSettings,
      artifactKey: options.artifactKey,
      confirmedLocal,
    })
    const preparedAgentCase =
      variant.kind === "model"
        ? undefined
        : await prepareAgentTargetCase(evalCase, variant, confirmedLocal)
    const targetCase = preparedAgentCase?.evalCase ?? evalCase
    const targetSample = await target.run(targetCase, signal)
    const sample = preparedAgentCase
      ? {
          ...targetSample,
          redactionPolicy: preparedAgentCase.policy,
          redactionDigest: preparedAgentCase.digest,
        }
      : targetSample
    const resolvedScorers = dependencies.resolveScorers(experiment.manifest, options.appSettings)
    const scorers = Array.isArray(resolvedScorers) ? resolvedScorers : resolvedScorers.scorers
    const judgeUsageBefore = Array.isArray(resolvedScorers)
      ? { inputTokens: 0, outputTokens: 0, cost: 0 }
      : (resolvedScorers.getJudgeAccounting?.() ?? {
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        })
    const judgeEvidence = redactJudgeEvidence(evalCase, sample)
    const judgeRedactionDigest = await digestTargetPayload(judgeEvidence)
    const scores = await Promise.all(
      scorers.map(async (scorer) => {
        try {
          return await scorer.score(
            scorer.requiresLlm ? judgeEvidence.sample : sample,
            scorer.requiresLlm ? judgeEvidence.evalCase : evalCase
          )
        } catch (error) {
          return errorScore(scorer, error)
        }
      })
    )
    const judgeUsageAfter = Array.isArray(resolvedScorers)
      ? judgeUsageBefore
      : (resolvedScorers.getJudgeAccounting?.() ?? judgeUsageBefore)
    const judgeUsage = {
      inputTokens: Math.max(0, judgeUsageAfter.inputTokens - judgeUsageBefore.inputTokens),
      outputTokens: Math.max(0, judgeUsageAfter.outputTokens - judgeUsageBefore.outputTokens),
    }
    const actualJudgeCost = Math.max(0, judgeUsageAfter.cost - judgeUsageBefore.cost)
    const actualCost = sample.costUsd + actualJudgeCost
    const createdAt = dependencies.now()
    const sampleId = dependencies.newId()
    const encryptedArtifact = await dependencies.encryptArtifact(options.artifactKey, {
      case: evalCase,
      sample,
      variantId: variant.id,
      repetition: task.repetition,
    })
    const scoreRows: EvalScoreRow[] = await Promise.all(
      scores.map(async (score) => ({
        id: dependencies.newId(),
        experimentId: experiment.id,
        sampleId,
        scorerId: score.scorerId,
        scorerVersion: experiment.manifest.scorerVersions[score.scorerId] ?? "unversioned",
        value: score.value,
        passed: score.passed,
        status: score.status,
        dimension: score.dimension,
        ...(score.error ? { error: score.error } : {}),
        ...(score.metadata ? { metadata: score.metadata } : {}),
        ...(score.reasoning
          ? {
              encryptedReasoning: await dependencies.encryptArtifact(options.artifactKey, {
                reasoning: score.reasoning,
              }),
            }
          : {}),
        createdAt,
      }))
    )
    const persistedSample: EvalSampleRow = {
      id: sampleId,
      experimentId: experiment.id,
      taskId: task.id,
      variantId: variant.id,
      caseId: evalCase.id,
      repetition: task.repetition,
      encryptedArtifact,
      latencyMs: sample.latencyMs,
      inputTokens: sample.usage.inputTokens,
      outputTokens: sample.usage.outputTokens,
      judgeInputTokens: judgeUsage.inputTokens,
      judgeOutputTokens: judgeUsage.outputTokens,
      judgeCost: actualJudgeCost,
      judgeRedactionPolicy: "redacted",
      judgeRedactionDigest,
      actualCost,
      createdAt,
      expiresAt: createdAt + experiment.manifest.retentionDays * DAY_MS,
    }
    return {
      actualCost,
      value: { sample: persistedSample, scores: scoreRows },
    }
  }
}

export function createBrowserEvalOrchestrator(
  options: BrowserEvalExecutorOptions,
  orchestratorOptions: EvalOrchestratorOptions = {}
): DurableEvalOrchestrator<EvalExecutedTaskArtifacts> {
  return new DurableEvalOrchestrator(
    new DexieEvalOrchestratorRepository(options.artifactKey),
    createBrowserEvalTaskExecutor(options),
    orchestratorOptions
  )
}
