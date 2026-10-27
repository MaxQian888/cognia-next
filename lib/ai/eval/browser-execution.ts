import type { AppSettings } from "@cognia/agent-config-types"
import type {
  EvalExperimentManifest,
  EvalExperimentState,
  EvalTask,
  EvalVariant,
  EvalAttemptObservation,
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
  recordEvalAttempt,
  type EvalExperimentRow,
  type EvalSampleRow,
  type EvalScoreRow,
  type EvalPersistenceScope,
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
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import {
  digestEvalDependency,
  estimateEvalTaskCost,
  readEvalTargetDependency,
} from "./project-service"

const DAY_MS = 24 * 60 * 60 * 1_000
const TARGET_PART_SEPARATOR = "\u001eCOGNIA_EVAL_TARGET_PART\u001e"

export interface EvalExecutedTaskArtifacts {
  sample: EvalSampleRow
  scores: EvalScoreRow[]
}

export class DexieEvalOrchestratorRepository implements EvalOrchestratorRepository<EvalExecutedTaskArtifacts> {
  constructor(
    private readonly artifactKey?: Uint8Array,
    private readonly scope?: EvalPersistenceScope
  ) {}

  private database() {
    this.scope?.assertActive()
    return this.scope?.db ?? getDb()
  }
  async getExperiment(
    id: string
  ): Promise<
    { state: EvalExperimentState; hardCap: number; concurrencyLimit?: number } | undefined
  > {
    const experiment = await this.database().evalExperiments.get(id)
    return experiment
      ? {
          state: experiment.state,
          hardCap: experiment.budgetCap ?? experiment.manifest.budget.hardCap,
          concurrencyLimit: experiment.manifest.executionProtocol?.outerConcurrency,
        }
      : undefined
  }

  async listTasks(experimentId: string) {
    const db = this.database()
    const [rows, experiment] = await Promise.all([
      db.evalTasks.where("experimentId").equals(experimentId).toArray(),
      db.evalExperiments.get(experimentId),
    ])
    this.scope?.assertActive()
    return rows.map((task) => {
      const variant = experiment?.manifest.variants.find((item) => item.id === task.variantId)
      return {
        ...task,
        ...(variant?.kind === "team" && variant.targetId
          ? { concurrencyKey: `team:${variant.targetId}` }
          : {}),
      }
    })
  }

  async setExperimentState(
    id: string,
    state: EvalExperimentState,
    details: { pauseReason?: "user" | "budget" | "rate-limit" | "recovery"; failure?: string } = {}
  ): Promise<void> {
    const db = this.database()
    await db.transaction("rw", db.evalExperiments, async () => {
      const current = await db.evalExperiments.get(id)
      this.scope?.assertActive()
      if (!current || ["completed", "cancelled", "failed"].includes(current.state)) return
      if (current.state === "paused" && state === "running") return
      await db.evalExperiments.update(id, {
        state,
        pauseReason: details.pauseReason,
        failure: details.failure,
        updatedAt: Date.now(),
      })
    })
  }

  async updateTask(id: string, patch: Partial<EvalTask> & { lastError?: string }): Promise<void> {
    const db = this.database()
    await db.transaction("rw", db.evalTasks, async () => {
      const current = await db.evalTasks.get(id)
      this.scope?.assertActive()
      if (!current || ["completed", "cancelled", "failed", "interrupted"].includes(current.state))
        return
      await db.evalTasks.update(id, patch)
    })
  }

  async reserveTask(taskId: string, worstCaseCost: number): Promise<boolean> {
    const db = this.database()
    return db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
      const task = await db.evalTasks.get(taskId)
      if (!task || task.state !== "queued") return false
      const experiment = await db.evalExperiments.get(task.experimentId)
      if (
        !experiment ||
        ["paused", "cancelled", "completed", "failed", "interrupted"].includes(experiment.state)
      ) {
        return false
      }
      this.scope?.assertActive()
      const reservation = Math.max(0, worstCaseCost)
      const reservationDelta = Math.max(0, reservation - task.reservedCost)
      if (
        experiment.spentCost + experiment.reservedCost + reservationDelta >
        (experiment.budgetCap ?? experiment.manifest.budget.hardCap)
      ) {
        return false
      }
      await db.evalTasks.update(taskId, {
        state: "running",
        reservedCost: reservation,
        updatedAt: Date.now(),
      })
      this.scope?.assertActive()
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
    await completeEvalTask(
      { task, sample: result.value.sample, scores: result.value.scores },
      this.scope
    )
  }

  async recordAttempt(
    task: EvalTask,
    observation: EvalAttemptObservation,
    result?: EvalTaskExecutionResult<EvalExecutedTaskArtifacts>
  ): Promise<void> {
    await recordEvalAttempt(
      {
        task,
        observation,
        ...(result ? { sample: result.value.sample, scores: result.value.scores } : {}),
      },
      this.scope
    )
  }

  async releaseTaskReservation(taskId: string): Promise<void> {
    const db = this.database()
    await db.transaction("rw", [db.evalTasks, db.evalExperiments], async () => {
      const task = await db.evalTasks.get(taskId)
      if (!task || task.reservedCost <= 0) return
      const experiment = await db.evalExperiments.get(task.experimentId)
      this.scope?.assertActive()
      await db.evalTasks.update(taskId, { reservedCost: 0, updatedAt: Date.now() })
      if (experiment) {
        this.scope?.assertActive()
        await db.evalExperiments.update(experiment.id, {
          reservedCost: Math.max(0, experiment.reservedCost - task.reservedCost),
          updatedAt: Date.now(),
        })
      }
    })
  }

  prepareNextStage(experimentId: string): Promise<boolean> {
    this.scope?.assertActive()
    return prepareNextEvalStage(experimentId, { artifactKey: this.artifactKey, scope: this.scope })
  }
}

interface BuildTargetInput {
  manifest: EvalExperimentManifest
  variant: EvalVariant
  appSettings: AppSettings
  artifactKey: Uint8Array
  confirmedLocal: boolean
  scope?: EvalPersistenceScope
}

export interface BrowserEvalExecutorDependencies {
  loadExperiment(id: string): Promise<EvalExperimentRow | undefined>
  loadCase(id: string): Promise<EvalCase | undefined>
  readTargetDependency(variant: EvalVariant): Promise<unknown>
  buildTarget(input: BuildTargetInput): EvalTarget
  resolveScorers(
    manifest: EvalExperimentManifest,
    appSettings: AppSettings,
    execution?: { signal: AbortSignal; assertActive(): void; costLimitUsd?: number }
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
  getJudgeAccounting?: () => JudgeUsage & {
    cost: number
    costStatus?: EvalAttemptObservation["costStatus"]
  }
}

export interface BrowserEvalExecutorOptions {
  appSettings: AppSettings
  artifactKey: Uint8Array
  scope?: EvalPersistenceScope
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
      ...(typeof variant.parameters?.maxCostUsd === "number"
        ? { maxCostUsd: variant.parameters.maxCostUsd }
        : {}),
      ...(variant.price ? { price: variant.price } : {}),
    }
  }
  if (variant.kind === "workflow") {
    const workflowVersionId = variant.parameters?.workflowVersionId
    return {
      kind: "workflow",
      label: variant.name,
      workflowId: required(variant.targetId, "Workflow id"),
      ...(typeof workflowVersionId === "string" && workflowVersionId.trim()
        ? { versionId: workflowVersionId }
        : {}),
    }
  }
  throw new Error(`Variant ${variant.id} is not an Agent target`)
}

async function artifactResolver(
  artifactKey: Uint8Array,
  assetId: string,
  requireCloudClearance: boolean,
  scope?: EvalPersistenceScope
) {
  scope?.assertActive()
  const asset = await (scope?.db ?? getDb()).evalAssets.get(assetId)
  scope?.assertActive()
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
  scope?.assertActive()
  return { data: decrypted.data, mediaType: decrypted.mediaType ?? asset.mediaType }
}

function defaultBuildTarget({
  variant,
  appSettings,
  artifactKey,
  confirmedLocal,
  scope,
}: BuildTargetInput): EvalTarget {
  if (variant.kind !== "model") {
    return createTargetFromSpec(agentTargetSpec(variant), {
      chat: {
        ...defaultChatTargetDeps(scope),
        resolveAsset: (assetId) => artifactResolver(artifactKey, assetId, !confirmedLocal, scope),
      },
      team: defaultTeamTargetDeps(scope),
      workflow: defaultWorkflowTargetDeps(scope),
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
      resolveAsset: (assetId) => artifactResolver(artifactKey, assetId, !confirmedLocal, scope),
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
  if (variant.kind !== "model" && variant.kind !== "chat") return false
  return confirmedProviderLocality(variant.providerId, appSettings)
}

function confirmedProviderLocality(
  providerId: string | undefined,
  appSettings: AppSettings
): boolean {
  if (!providerId) return false
  const resolution = resolveFeatureProvider(
    {
      featureId: "eval.locality",
      routeProfile: "capability-bound",
      selectionMode: "explicit-provider",
      providerId,
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
  appSettings: AppSettings,
  execution?: { signal: AbortSignal; assertActive(): void; costLimitUsd?: number }
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
  let admittedJudgeCost = 0
  let admittedJudgeCalls = 0
  let ambiguousJudgeSpend = false
  const scopedJudge = (
    judge: NonNullable<typeof client>,
    price: EvalExperimentManifest["judgePolicy"]["price"]
  ) => ({
    ...judge,
    async complete(prompt: string, options?: Parameters<typeof judge.complete>[1]) {
      execution?.assertActive()
      const maxTokens = options?.maxTokens ?? manifest.judgePolicy.maxOutputTokens ?? 300
      if (!Number.isInteger(maxTokens) || maxTokens <= 0)
        throw new Error("Evaluation judge requires a bounded output token limit")
      // A loopback endpoint can forward to a paid cloud provider. Explicit
      // prices (including an explicitly configured zero rate) are required.
      if (
        !price ||
        !Number.isFinite(price.inputPerMillion) ||
        price.inputPerMillion < 0 ||
        !Number.isFinite(price.outputPerMillion) ||
        price.outputPerMillion < 0 ||
        !execution ||
        !Number.isFinite(execution.costLimitUsd) ||
        execution.costLimitUsd! < 0
      ) {
        throw new Error("Evaluation judge requires an explicit priced per-call budget")
      }
      // A byte upper bound avoids optimistic character/token ratios. Keep
      // provider framing overhead in the reservation and turn SDK retries
      // off so one admission cannot silently buy several requests.
      const inputBound = new TextEncoder().encode(prompt + (options?.system ?? "")).byteLength + 512
      const reservation =
        (inputBound * price.inputPerMillion + maxTokens * price.outputPerMillion) / 1_000_000
      if (
        !Number.isFinite(reservation) ||
        reservation < 0 ||
        admittedJudgeCost + reservation > execution.costLimitUsd!
      ) {
        throw new Error("Evaluation judge call exceeds its reserved budget")
      }
      admittedJudgeCost += reservation
      if (!hasNoLeakingPiiDeep({ prompt, system: options?.system })) {
        throw new Error("Evaluation judge prompt blocked by the PII gate")
      }
      if (price.inputPerMillion + price.outputPerMillion > 0) admittedJudgeCalls += 1
      try {
        const result = await judge.complete(prompt, {
          ...options,
          maxTokens,
          maxRetries: 0,
          ...(execution ? { abortSignal: execution.signal } : {}),
        })
        if (price.inputPerMillion + price.outputPerMillion > 0 && !judge.getUsageSnapshot)
          ambiguousJudgeSpend = true
        return result
      } catch (error) {
        // A failed HTTP/client response does not prove the provider did not
        // perform billable work. Preserve uncertainty instead of booking zero.
        if (price.inputPerMillion + price.outputPerMillion > 0) ambiguousJudgeSpend = true
        throw error
      }
    },
  })
  const primaryScorers = llmScorers({
    client: scopedJudge(client, manifest.judgePolicy.price),
  })
  const secondaryScorers = secondClient
    ? llmScorers({
        client: scopedJudge(secondClient, manifest.judgePolicy.secondJudgePrice),
      })
    : []
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
    price: EvalExperimentManifest["judgePolicy"]["price"]
  ) => {
    const usage = judgeClient.getUsageSnapshot?.()
    const inputTokens = usage?.inputTokens ?? 0
    const outputTokens = usage?.outputTokens ?? 0
    return {
      inputTokens,
      outputTokens,
      cost: !price
        ? 0
        : (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000,
    }
  }
  return {
    scorers: [...scorers, ...escalatedScorers],
    getJudgeAccounting: () => {
      const primary = accountingFor(client, manifest.judgePolicy.price)
      const secondary = secondClient
        ? accountingFor(secondClient, manifest.judgePolicy.secondJudgePrice)
        : { inputTokens: 0, outputTokens: 0, cost: 0 }
      return {
        inputTokens: primary.inputTokens + secondary.inputTokens,
        outputTokens: primary.outputTokens + secondary.outputTokens,
        cost: primary.cost + secondary.cost,
        costStatus:
          ambiguousJudgeSpend ||
          (admittedJudgeCalls > 0 &&
            primary.inputTokens +
              primary.outputTokens +
              secondary.inputTokens +
              secondary.outputTokens ===
              0)
            ? "partial"
            : "estimated",
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
    loadExperiment: (id) => (options.scope?.db ?? getDb()).evalExperiments.get(id),
    loadCase: options.scope ? (id) => options.scope!.db.evalCases.get(id) : getCase,
    readTargetDependency: (variant) => readEvalTargetDependency(variant, options.scope),
    buildTarget: defaultBuildTarget,
    resolveScorers: defaultResolveScorers,
    encryptArtifact: encryptEvalArtifact,
    now: Date.now,
    newId: () => crypto.randomUUID(),
    ...overrides,
  }

  return async (task, signal) => {
    const assertScope = () => options.scope?.assertActive()
    const assertActive = () => {
      options.scope?.assertActive()
      signal.throwIfAborted()
    }
    assertActive()
    const experiment = await dependencies.loadExperiment(task.experimentId)
    assertActive()
    if (!experiment) throw new Error(`Evaluation experiment ${task.experimentId} not found`)
    const variant = experiment.manifest.variants.find((item) => item.id === task.variantId)
    if (!variant) throw new Error(`Evaluation variant ${task.variantId} not found in manifest`)
    const evalCase = await dependencies.loadCase(task.caseId)
    assertActive()
    if (!evalCase) throw new Error(`Evaluation case ${task.caseId} not found`)
    const caseDigest = experiment.manifest.caseDigests?.[task.caseId]
    if (caseDigest && caseDigest !== (await digestEvalDependency(evalCase))) {
      throw new Error(`Evaluation case ${task.caseId} changed since the manifest was created`)
    }
    const targetDigest = experiment.manifest.targetDigests?.[variant.id]
    if (
      targetDigest &&
      targetDigest !==
        (await digestEvalDependency(await dependencies.readTargetDependency(variant)))
    ) {
      throw new Error(`Evaluation target ${variant.id} changed since the manifest was created`)
    }
    const caseReservation =
      Number.isFinite(task.reservedCost) && task.reservedCost > 0
        ? task.reservedCost
        : Math.max(
            0,
            (experiment.budgetCap ?? experiment.manifest.budget.hardCap) -
              experiment.spentCost -
              experiment.reservedCost
          )
    const judgeReservation = estimateEvalTaskCost(
      { ...variant, kind: "model", isLocal: true },
      experiment.manifest.judgePolicy
    )
    const targetLimit = Math.max(0, caseReservation - judgeReservation)
    const boundedVariant =
      variant.kind === "team"
        ? {
            ...variant,
            parameters: {
              ...variant.parameters,
              maxCostUsd: Math.min(
                typeof variant.parameters?.maxCostUsd === "number"
                  ? variant.parameters.maxCostUsd
                  : targetLimit,
                targetLimit
              ),
            },
          }
        : variant
    const confirmedLocal = confirmedVariantLocality(variant, options.appSettings)
    const target = dependencies.buildTarget({
      manifest: experiment.manifest,
      variant: boundedVariant,
      appSettings: options.appSettings,
      artifactKey: options.artifactKey,
      confirmedLocal,
      scope: options.scope,
    })
    const preparedAgentCase =
      variant.kind === "model"
        ? undefined
        : await prepareAgentTargetCase(evalCase, variant, confirmedLocal)
    const targetCase = preparedAgentCase?.evalCase ?? evalCase
    assertActive()
    const targetSample = await target.run(targetCase, signal)
    // An abort after model work must not discard returned usage or elapsed
    // time. Account scope still fences persistence to the owning account.
    assertScope()
    const capturedSample: EvalSample = {
      ...targetSample,
      executionStatus: signal.aborted
        ? "cancelled"
        : (targetSample.executionStatus ?? (targetSample.error ? "failed" : "completed")),
      ...(signal.aborted
        ? { error: targetSample.error ?? "Evaluation cancelled after execution" }
        : {}),
    }
    const sample = preparedAgentCase
      ? {
          ...capturedSample,
          redactionPolicy: preparedAgentCase.policy,
          redactionDigest: preparedAgentCase.digest,
        }
      : capturedSample
    let resolutionError: unknown
    let resolvedScorers: Scorer[] | ResolvedEvalScorers = []
    if (!signal.aborted) {
      try {
        resolvedScorers = dependencies.resolveScorers(experiment.manifest, options.appSettings, {
          signal,
          assertActive,
          costLimitUsd:
            sample.metricAvailability?.cost === "unavailable" ||
            sample.metricAvailability?.cost === "partial"
              ? 0
              : Math.max(0, caseReservation - sample.costUsd),
        })
      } catch (error) {
        resolutionError = error
      }
    }
    const scorers = signal.aborted
      ? []
      : Array.isArray(resolvedScorers)
        ? resolvedScorers
        : resolvedScorers.scorers
    const judgeUsageBefore = Array.isArray(resolvedScorers)
      ? { inputTokens: 0, outputTokens: 0, cost: 0 }
      : (resolvedScorers.getJudgeAccounting?.() ?? {
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        })
    const judgeEvidence = redactJudgeEvidence(evalCase, sample)
    const judgeRedactionDigest = await digestTargetPayload(judgeEvidence)
    assertScope()
    const scores = await Promise.all(
      scorers.map(async (scorer) => {
        try {
          assertActive()
          return await scorer.score(
            scorer.requiresLlm ? judgeEvidence.sample : sample,
            scorer.requiresLlm ? judgeEvidence.evalCase : evalCase
          )
        } catch (error) {
          return errorScore(scorer, error)
        }
      })
    )
    if (resolutionError)
      scores.push({
        scorerId: "evaluation-configuration",
        dimension: "response-quality",
        status: "errored",
        value: 0,
        passed: false,
        error: resolutionError instanceof Error ? resolutionError.message : String(resolutionError),
      })
    assertScope()
    const judgeUsageAfter = Array.isArray(resolvedScorers)
      ? judgeUsageBefore
      : (resolvedScorers.getJudgeAccounting?.() ?? judgeUsageBefore)
    const judgeUsage = {
      inputTokens: Math.max(0, judgeUsageAfter.inputTokens - judgeUsageBefore.inputTokens),
      outputTokens: Math.max(0, judgeUsageAfter.outputTokens - judgeUsageBefore.outputTokens),
    }
    const actualJudgeCost = Math.max(0, judgeUsageAfter.cost - judgeUsageBefore.cost)
    const actualCost = sample.costUsd + actualJudgeCost
    const judgeCostUnknown =
      "costStatus" in judgeUsageAfter &&
      (judgeUsageAfter.costStatus === "partial" || judgeUsageAfter.costStatus === "unavailable")
    if (judgeCostUnknown)
      sample.metricAvailability = {
        usage: sample.metricAvailability?.usage ?? "known",
        latency: sample.metricAvailability?.latency ?? "known",
        ...sample.metricAvailability,
        cost: "partial",
      }
    const createdAt = dependencies.now()
    const sampleId = dependencies.newId()
    const encryptedArtifact = await dependencies.encryptArtifact(options.artifactKey, {
      case: evalCase,
      sample,
      variantId: variant.id,
      repetition: task.repetition,
    })
    assertScope()
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
    assertScope()
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
      executionStatus: sample.executionStatus,
      metricAvailability: sample.metricAvailability,
      attempt: task.attempt,
      createdAt,
      expiresAt: createdAt + experiment.manifest.retentionDays * DAY_MS,
    }
    return {
      actualCost,
      costStatus: sample.metricAvailability?.cost ?? "estimated",
      executionStatus: sample.executionStatus,
      value: { sample: persistedSample, scores: scoreRows },
    }
  }
}

export function createBrowserEvalOrchestrator(
  options: BrowserEvalExecutorOptions,
  orchestratorOptions: EvalOrchestratorOptions = {}
): DurableEvalOrchestrator<EvalExecutedTaskArtifacts> {
  return new DurableEvalOrchestrator(
    new DexieEvalOrchestratorRepository(options.artifactKey, options.scope),
    createBrowserEvalTaskExecutor(options),
    orchestratorOptions
  )
}
