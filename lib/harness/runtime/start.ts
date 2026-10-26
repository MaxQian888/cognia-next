/**
 * Creating a Harness Evolution run (ADR-0237).
 *
 * A start checks that the feature is on and the trigger allowed, freezes the
 * task (input file hashes, the git base commit, the task hash), captures the
 * agent's harness as the base, checks that every model role the run needs can
 * be called from here, and stores the run, collapsing onto an unfinished run
 * with the same agent, task, base and configuration. It never runs anything:
 * the caller launches the stored run.
 *
 * {@link previewHarnessRun} is the start dialog's estimate: the scheduled
 * work (R = 4k rollouts, P = 3k editor sessions) priced from this person's
 * recent comparable runs (ADR-0232), and which budget ceilings it would cross.
 */

import type { AppSettings, Character } from "@cognia/agent-config-types"
import type {
  HarnessEditorChannel,
  HarnessEvolutionBudget,
  HarnessEvolutionMode,
  HarnessEvolutionRun,
  HarnessEvolutionRunConfig,
  HarnessEvolutionTask,
  HarnessEvolutionTrigger,
  HarnessIsolationKind,
  HarnessRole,
  HarnessRoleModels,
  HarnessTaskCheck,
  HarnessTaskSource,
} from "@/types/harness/evolution"
import {
  HARNESS_COMPONENT_NAMES,
  type HarnessComponentName,
  type HarnessScope,
} from "@/types/harness/snapshot"
import { effectiveK, emptyLedger, estimateRun, normalizeBudget, type RunEstimate } from "../budget"
import { taskInputHash } from "../evidence"
import { runDedupeKey } from "../machine"
import { finalLabels } from "../recursion"
import { harnessEvolutionSettingsOf, isStartAllowed } from "../settings"
import type { CapturedHarness } from "./capture"
import { roleModel } from "./model-call"

export interface HarnessTaskDraft {
  title: string
  prompt: string
  /** Grouping for the experience library; normalised to lower-case `a/b` form. */
  domain?: string
  isolation: HarnessIsolationKind
  inputFiles?: { sourcePath: string; relativePath: string }[]
  git?: { sourceRoot: string; baseRef?: string; projectId?: string }
  expectedDeliverables?: string[]
  checks?: HarnessTaskCheck[]
  source: HarnessTaskSource
}

export interface HarnessRunOverrides {
  mode?: HarnessEvolutionMode
  k?: number
  scope?: HarnessScope
  editable?: HarnessComponentName[]
  budget?: Partial<HarnessEvolutionBudget>
  models?: HarnessRoleModels
  autoAdoptLowRisk?: boolean
  useExperiences?: boolean
  editorChannel?: HarnessEditorChannel
  networkOff?: boolean
}

export interface StartHarnessRunInput {
  characterId: string
  trigger: HarnessEvolutionTrigger
  task: HarnessTaskDraft
  projectId?: string
  sessionId?: string
  overrides?: HarnessRunOverrides
}

export class HarnessStartError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "trigger-not-allowed"
      | "invalid-task"
      | "no-commit"
      | "model-unavailable"
      | "no-session"
      | "no-workspace",
    message: string
  ) {
    super(message)
    this.name = "HarnessStartError"
  }
}

export interface StartDeps {
  getSettings(): Promise<AppSettings | null>
  capture(
    characterId: string,
    options: { scope: HarnessScope; projectId?: string }
  ): Promise<CapturedHarness>
  /** SHA-256 of a host file's bytes. */
  hashFile(sourcePath: string): Promise<string>
  /** The commit at HEAD of a repository, or `undefined` when it has none. */
  headCommit(sourceRoot: string): Promise<string | undefined>
  /** Whether a model client for this role can be built here. */
  canCallModel(model: { providerId?: string; model?: string }): Promise<boolean>
  createRun(run: HarnessEvolutionRun): Promise<{ created: boolean; run: HarnessEvolutionRun }>
  now(): number
  newId(): string
  /** Seed of the selector's anonymous ids. */
  seed(): number
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

/** Lower-case, slash-separated, no empty segments; `general` when blank. */
export function normalizeDomain(domain: string | undefined): string {
  const segments = (domain ?? "")
    .toLowerCase()
    .split("/")
    .map((s) =>
      s
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}._-]/gu, "")
    )
    .filter(Boolean)
  return segments.length ? segments.join("/") : "general"
}

function relativeOk(path: string): boolean {
  const p = path.replace(/\\/g, "/")
  return (
    p.length > 0 &&
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split("/").some((seg) => seg === ".." || seg === "")
  )
}

/** Problems with a task draft, as sentences; empty when it is runnable. */
export function validateTaskDraft(task: HarnessTaskDraft): string[] {
  const errors: string[] = []
  if (!task.title.trim()) errors.push("The task needs a title.")
  if (!task.prompt.trim()) errors.push("The task needs the request the agent receives.")
  if (task.isolation === "git" && !task.git?.sourceRoot) {
    errors.push("A git task needs the repository it starts from.")
  }
  if (task.isolation !== "files" && task.inputFiles?.length) {
    errors.push("Input files are copied only into a scratch-directory task.")
  }
  const relPaths = new Set<string>()
  for (const file of task.inputFiles ?? []) {
    if (!relativeOk(file.relativePath)) {
      errors.push(`Input file path ${file.relativePath} must be relative and stay inside the task.`)
    }
    if (relPaths.has(file.relativePath)) errors.push(`Two input files go to ${file.relativePath}.`)
    relPaths.add(file.relativePath)
  }
  for (const path of task.expectedDeliverables ?? []) {
    if (!relativeOk(path)) errors.push(`Deliverable path ${path} must be relative.`)
  }
  for (const check of task.checks ?? []) {
    if (check.kind === "deliverable-file" && !relativeOk(check.path)) {
      errors.push(`Check path ${check.path} must be relative.`)
    }
    if (check.kind === "deliverable-file" && task.isolation === "none") {
      errors.push("A text-only task cannot check for files.")
    }
    if (check.kind === "acceptance-profile" && (task.isolation !== "git" || !task.git?.projectId)) {
      errors.push("Acceptance profiles run only on a git task in a workspace.")
    }
    if (
      (check.kind === "output-contains" || check.kind === "output-not-contains") &&
      !check.value
    ) {
      errors.push("An output check needs the text to look for.")
    }
  }
  if (task.isolation === "none" && task.expectedDeliverables?.length) {
    errors.push("A text-only task cannot produce files.")
  }
  return errors
}

/** The roles whose model is called directly (not through an agent session). */
function directRoles(channel: HarnessEditorChannel): HarnessRole[] {
  return channel === "agentic"
    ? ["selector", "reflector"]
    : ["editor", "composer", "selector", "reflector"]
}

/** The run configuration the settings and the start dialog's overrides describe. */
export function buildRunConfig(
  settings: AppSettings | null,
  overrides: HarnessRunOverrides | undefined,
  seed: number
): HarnessEvolutionRunConfig {
  const s = harnessEvolutionSettingsOf(settings)
  const budget = normalizeBudget({ ...s.budget, ...(overrides?.budget ?? {}) })
  const editable = overrides?.editable?.length
    ? HARNESS_COMPONENT_NAMES.filter((c) => overrides.editable?.includes(c))
    : [...HARNESS_COMPONENT_NAMES]
  return {
    mode: overrides?.mode ?? s.defaultMode,
    k: effectiveK(overrides?.k ?? s.defaultK, budget),
    scope: overrides?.scope ?? "task",
    editable,
    models: { ...s.models, ...(overrides?.models ?? {}) },
    budget,
    autoAdoptLowRisk: overrides?.autoAdoptLowRisk ?? s.autoAdoptLowRisk,
    useExperiences: overrides?.useExperiences ?? s.useExperiences,
    editorChannel: overrides?.editorChannel ?? s.editorChannel,
    probe: {
      allowedMcpServerIds: [...s.probeAllowedMcpServerIds],
      networkOff: overrides?.networkOff ?? true,
    },
    seed,
  }
}

/** Freeze a draft: file hashes, the base commit and the task hash. */
export async function freezeTask(
  draft: HarnessTaskDraft,
  deps: Pick<StartDeps, "hashFile" | "headCommit">
): Promise<HarnessEvolutionTask> {
  const errors = validateTaskDraft(draft)
  if (errors.length) throw new HarnessStartError("invalid-task", errors.join(" "))
  const inputFiles = await Promise.all(
    (draft.inputFiles ?? []).map(async (f) => ({
      sourcePath: f.sourcePath,
      relativePath: f.relativePath.replace(/\\/g, "/"),
      sha256: await deps.hashFile(f.sourcePath),
    }))
  )
  let git: HarnessEvolutionTask["git"]
  if (draft.isolation === "git" && draft.git) {
    const ref = draft.git.baseRef?.trim()
    let sha: string | undefined
    if (!ref || ref === "HEAD") sha = await deps.headCommit(draft.git.sourceRoot)
    else if (FULL_SHA.test(ref)) sha = ref.toLowerCase()
    else {
      throw new HarnessStartError(
        "invalid-task",
        "A git task starts from HEAD or from a full commit hash."
      )
    }
    if (!sha)
      throw new HarnessStartError("no-commit", "The repository has no commit to start from.")
    git = {
      sourceRoot: draft.git.sourceRoot,
      baseRef: ref || "HEAD",
      resolvedBaseSha: sha,
      ...(draft.git.projectId ? { projectId: draft.git.projectId } : {}),
    }
  }
  const task: Omit<HarnessEvolutionTask, "inputHash"> = {
    title: draft.title.trim(),
    prompt: draft.prompt,
    domain: normalizeDomain(draft.domain),
    isolation: draft.isolation,
    ...(inputFiles.length ? { inputFiles } : {}),
    ...(git ? { git } : {}),
    ...(draft.expectedDeliverables?.length
      ? { expectedDeliverables: draft.expectedDeliverables.map((p) => p.replace(/\\/g, "/")) }
      : {}),
    checks: [...(draft.checks ?? [])],
    source: draft.source,
  }
  return { ...task, inputHash: await taskInputHash(task) }
}

/** Check that every model role the run calls directly is reachable. */
export async function preflightModels(
  config: HarnessEvolutionRunConfig,
  agent: Pick<Character, "providerId" | "model">,
  deps: Pick<StartDeps, "canCallModel">
): Promise<void> {
  const missing: HarnessRole[] = []
  for (const role of directRoles(config.editorChannel)) {
    if (!(await deps.canCallModel(roleModel(role, config.models, agent)))) missing.push(role)
  }
  if (missing.length) {
    throw new HarnessStartError(
      "model-unavailable",
      `No model can be called for: ${missing.join(", ")}. Set a provider for these roles in the Harness Evolution settings.`
    )
  }
}

export async function startHarnessRun(
  input: StartHarnessRunInput,
  deps: StartDeps
): Promise<{ created: boolean; run: HarnessEvolutionRun }> {
  const appSettings = await deps.getSettings()
  const settings = harnessEvolutionSettingsOf(appSettings)
  if (!settings.enabled) {
    throw new HarnessStartError("disabled", "Harness Evolution is turned off in Settings.")
  }
  if (!isStartAllowed(settings, input.trigger)) {
    throw new HarnessStartError(
      "trigger-not-allowed",
      `Runs started ${input.trigger === "background" ? "in the background" : "after a failure"} are not allowed by the current settings.`
    )
  }
  const config = buildRunConfig(appSettings, input.overrides, deps.seed())
  if (config.scope === "session" && !input.sessionId) {
    throw new HarnessStartError(
      "no-session",
      "Session scope needs the conversation the run starts from."
    )
  }
  if (config.scope === "workspace" && !input.projectId) {
    throw new HarnessStartError("no-workspace", "Workspace scope needs a workspace.")
  }
  const task = await freezeTask(input.task, deps)
  const captured = await deps.capture(input.characterId, {
    scope: config.scope,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  })
  await preflightModels(config, captured.character, deps)
  const now = deps.now()
  const run: HarnessEvolutionRun = {
    id: deps.newId(),
    characterId: captured.character.id,
    characterName: captured.character.name,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    trigger: input.trigger,
    task,
    config,
    status: "queued",
    round: 0,
    baseSnapshotId: captured.snapshot.id,
    finalLabels: finalLabels(config.mode, config.k),
    experienceIds: [],
    ledger: emptyLedger(),
    dedupeKey: await runDedupeKey({
      characterId: captured.character.id,
      taskInputHash: task.inputHash,
      baseContentHash: captured.snapshot.contentHash,
      config,
    }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  return deps.createRun(run)
}

export interface HarnessRunPreview {
  estimate: RunEstimate
  /** How much history the unit figures rest on (ADR-0232 confidence). */
  confidence: "based" | "few" | "rough" | "none"
  sampleCount: number
}

/**
 * The start dialog's estimate. A rollout is priced like one comparable
 * single-agent run (best-of-N candidates are the nearest history), at its p90
 * so the ceiling check is conservative; an editor session reads about one
 * rollout's worth of evidence, so it is priced at a rollout's median.
 */
export async function previewHarnessRun(
  config: Pick<HarnessEvolutionRunConfig, "mode" | "k" | "budget" | "models">,
  agent: Pick<Character, "providerId" | "model">,
  deps: {
    estimateSingleRun(query: { model?: string; providerId?: string }): Promise<{
      confidence: HarnessRunPreview["confidence"]
      sampleCount: number
      costUsd: { p50: number; p90: number } | null
      tokens: { p50: number; p90: number } | null
      durationMs: { p50: number; p90: number } | null
    }>
  }
): Promise<HarnessRunPreview> {
  const executor = roleModel("executor", config.models, agent)
  const single = await deps.estimateSingleRun({
    ...(executor.model ? { model: executor.model } : {}),
    ...(executor.providerId ? { providerId: executor.providerId } : {}),
  })
  const estimate = estimateRun(config.mode, config.k, config.budget, {
    ...(single.costUsd ? { rolloutUsd: single.costUsd.p90, sessionUsd: single.costUsd.p50 } : {}),
    ...(single.tokens
      ? { rolloutTokens: single.tokens.p90, sessionTokens: single.tokens.p50 }
      : {}),
    ...(single.durationMs ? { rolloutMs: single.durationMs.p90 } : {}),
  })
  return { estimate, confidence: single.confidence, sampleCount: single.sampleCount }
}

/** Production dependencies. */
export async function defaultStartDeps(): Promise<StartDeps> {
  const [settingsDb, store, capture, modelCall, scm, isolation] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/lib/db/harness-evolution"),
    import("./capture"),
    import("./model-call"),
    import("@/lib/scm/service"),
    import("./isolation"),
  ])
  const [captureDeps, modelDeps, isolationDeps] = await Promise.all([
    capture.defaultCaptureDeps(),
    modelCall.defaultHarnessModelDeps(),
    isolation.defaultIsolationDeps(),
  ])
  return {
    getSettings: async () => (await settingsDb.getSettings()) ?? null,
    capture: (characterId, options) => capture.captureHarness(characterId, options, captureDeps),
    hashFile: async (sourcePath) => {
      // Read exactly as a rollout reads it, so the two hashes compare.
      const { dir, name } = isolation.splitPath(sourcePath)
      const b64 = await isolationDeps.fs.readHostFileBase64(dir, name)
      return isolation.sha256OfBytes(isolation.base64ToBytes(b64))
    },
    headCommit: async (sourceRoot) =>
      (await scm.getSourceControlService().history(sourceRoot, { maxCount: 1 }))[0]?.hash,
    canCallModel: async (model) => (await modelCall.clientForRole(model, modelDeps)) !== null,
    createRun: store.createHarnessRun,
    now: Date.now,
    newId: () => crypto.randomUUID(),
    seed: () => Math.floor(Math.random() * 2 ** 31),
  }
}

/** Production estimate of one comparable single-agent run (ADR-0232). */
export async function defaultEstimateSingleRun(query: { model?: string; providerId?: string }) {
  const { estimateLaunchNow } = await import("@/lib/usage/run-estimate/launch")
  const estimate = await estimateLaunchNow([
    {
      surface: "best-of-n",
      ...(query.model ? { model: query.model } : {}),
      ...(query.providerId ? { providerId: query.providerId } : {}),
    },
  ])
  return {
    confidence: estimate.confidence,
    sampleCount: estimate.sampleCount,
    costUsd: estimate.costUsd,
    tokens: estimate.tokens,
    durationMs: estimate.durationMs,
  }
}
