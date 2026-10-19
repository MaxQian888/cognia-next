/**
 * Harness Evolution runs, steps and evidence (ADR-0237).
 *
 * A run improves one agent's harness on one task by Propose–Probe–Compose,
 * in parallel or sequential recursion. Steps are labelled the way Harness²
 * labels them (`base1..k`, `inv1..k`, `dom1..k`, `agg1..k` or `c1..k`,
 * `select`, `reflect`), so the scheduled-work identity R = 4k rollouts and
 * P = 3k editor sessions can be checked from the rows.
 */

import type { HarnessComponentName, HarnessScope } from "./snapshot"

export type HarnessEvolutionMode = "parallel" | "sequential"

export const HARNESS_EVOLUTION_MODES: readonly HarnessEvolutionMode[] = ["parallel", "sequential"]

/** How a run was started. */
export type HarnessEvolutionTrigger = "manual" | "failure-triggered" | "background"

/** How each rollout gets a working directory of its own. */
export type HarnessIsolationKind = "none" | "files" | "git"

/** A deterministic check a rollout must pass. Checked before any model judgement. */
export type HarnessTaskCheck =
  | { kind: "deliverable-file"; path: string }
  | { kind: "output-contains"; value: string; caseSensitive?: boolean }
  | { kind: "output-not-contains"; value: string; caseSensitive?: boolean }
  | { kind: "output-json"; requiredKeys?: string[] }
  | { kind: "max-tool-errors"; max: number }
  | { kind: "acceptance-profile"; profileId: string }

export type HarnessTaskCheckKind = HarnessTaskCheck["kind"]

export type HarnessTaskSource =
  | { kind: "custom" }
  | { kind: "session"; sessionId: string; messageId?: string }
  | { kind: "eval-case"; datasetId: string; caseId: string }
  | { kind: "benchmark"; benchmarkId: string; taskId: string }

export interface HarnessTaskInputFile {
  /** Absolute path on the host the file is copied from. */
  sourcePath: string
  /** Path inside each rollout's working directory. */
  relativePath: string
  /** SHA-256 of the bytes at task creation; a mismatch invalidates caches. */
  sha256?: string
}

export interface HarnessTaskGitSource {
  /** Repository root on the host. */
  sourceRoot: string
  /** Ref the base was resolved from (default HEAD). */
  baseRef?: string
  /** The frozen commit every rollout starts from; resolved once per run. */
  resolvedBaseSha?: string
  projectId?: string
}

export interface HarnessEvolutionTask {
  title: string
  /** The request exactly as the agent receives it. */
  prompt: string
  /** Grouping for the experience library: a practice area, a stack, a work type. */
  domain: string
  isolation: HarnessIsolationKind
  inputFiles?: HarnessTaskInputFile[]
  git?: HarnessTaskGitSource
  /** Relative paths the task asks the agent to produce. */
  expectedDeliverables?: string[]
  checks: HarnessTaskCheck[]
  source: HarnessTaskSource
  /** SHA-256 over prompt, files, git base, deliverables and checks. */
  inputHash: string
}

/** Model choice for one role. Absent fields fall back to the agent's own model. */
export interface HarnessRoleModel {
  providerId?: string
  model?: string
}

export type HarnessRole = "executor" | "editor" | "composer" | "selector" | "reflector"

export const HARNESS_ROLES: readonly HarnessRole[] = [
  "executor",
  "editor",
  "composer",
  "selector",
  "reflector",
]

export type HarnessRoleModels = Partial<Record<HarnessRole, HarnessRoleModel>>

export interface HarnessEvolutionBudget {
  /** k: the task-level recursion budget. */
  maxIterations: number
  /** Cap on candidate harnesses proposed across the run. */
  maxCandidates: number
  /** Concurrent rollouts / editor sessions. */
  maxParallelRuns: number
  /** Editor, selector and reflector model calls. Rollouts are bounded by `maxTurnsPerRollout`. */
  maxModelCalls: number
  maxTokens: number
  maxCostUsd: number
  maxWallTimeMs: number
  /** Per-rollout agentic turn ceiling. */
  maxTurnsPerRollout: number
}

/** How editor sessions reach a model. */
export type HarnessEditorChannel = "auto" | "agentic" | "structured"

export interface HarnessProbePolicy {
  /** MCP servers the user declared read-only and safe to call during probes. */
  allowedMcpServerIds: string[]
  /** Ask the sandbox to cut network access where the runtime supports it. */
  networkOff: boolean
}

export interface HarnessEvolutionRunConfig {
  mode: HarnessEvolutionMode
  k: number
  /** Where an adopted harness applies. */
  scope: HarnessScope
  /** Components the editors may change. Everything else is locked. */
  editable: HarnessComponentName[]
  models: HarnessRoleModels
  budget: HarnessEvolutionBudget
  /** Adopt low-risk task/session improvements without asking. */
  autoAdoptLowRisk: boolean
  /** Hand the library's relevant experiences to the editors. */
  useExperiences: boolean
  editorChannel: HarnessEditorChannel
  probe: HarnessProbePolicy
  /** Seeds the anonymous ids the selector sees; reruns are reproducible. */
  seed: number
}

export type HarnessRunStatus =
  | "queued"
  | "snapshotting"
  | "reference_running"
  | "proposing"
  | "probing"
  | "composing"
  | "evaluating"
  | "awaiting_approval"
  | "adopting"
  | "reflecting"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded"
  | "rejected"
  | "rolled_back"
  | "interrupted"

export const HARNESS_RUN_STATUSES: readonly HarnessRunStatus[] = [
  "queued",
  "snapshotting",
  "reference_running",
  "proposing",
  "probing",
  "composing",
  "evaluating",
  "awaiting_approval",
  "adopting",
  "reflecting",
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
  "rejected",
  "rolled_back",
  "interrupted",
]

/** Spend recorded for one run, by step kind. */
export interface HarnessBudgetLedger {
  costUsd: number
  /** True when at least one step reported no price; `costUsd` is then a lower bound. */
  costUnknown: boolean
  inputTokens: number
  outputTokens: number
  modelCalls: number
  rollouts: number
  sessions: number
  /** Worst observed cost per step kind, used to reserve the next step. */
  maxObservedCostUsd: Partial<Record<HarnessStepKind, number>>
  startedAt?: number
}

export type HarnessDecisionOutcome = "adopt" | "keep-base"

export interface HarnessRunDecision {
  outcome: HarnessDecisionOutcome
  /** Why, in a sentence a person can audit. */
  reason: string
  chosenLabel?: string
  chosenSnapshotId?: string
  /** Risk class of the chosen harness's diff against the base. */
  risk?: HarnessRiskClass
  /** Whether a person must approve before adoption. */
  requiresApproval: boolean
}

export type HarnessRiskClass = "low" | "medium" | "high"

export interface HarnessRunAdoption {
  scope: HarnessScope
  /** `evalConfigurationApplies` row id for session/workspace/global scope. */
  applyId?: string
  /** The agent the harness was written to (the agent itself or an evolved variant). */
  targetCharacterId?: string
  variantCreated?: boolean
  setAsWorkspaceDefault?: boolean
  decisionId?: string
  adoptedAt: number
  rolledBackAt?: number
}

export interface HarnessRunOwner {
  ownerId: string
  leaseExpiresAt: number
}

export interface HarnessEvolutionRun {
  id: string
  characterId: string
  characterName: string
  projectId?: string
  /** The conversation the run was started from, when there was one. */
  sessionId?: string
  trigger: HarnessEvolutionTrigger
  task: HarnessEvolutionTask
  config: HarnessEvolutionRunConfig
  status: HarnessRunStatus
  /** Sequential mode: the current round, 1-based. */
  round: number
  baseSnapshotId?: string
  /** Labels of the finals (`agg1..k` or `c1..k`). */
  finalLabels: string[]
  decision?: HarnessRunDecision
  adoption?: HarnessRunAdoption
  experienceIds: string[]
  ledger: HarnessBudgetLedger
  /** Why a terminal non-success status was reached. */
  error?: string
  /** Same agent + task + base + config collapse onto one active run. */
  dedupeKey: string
  owner?: HarnessRunOwner
  /** Compare-and-swap counter for every mutation. */
  version: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
}

export type HarnessStepKind = "rollout" | "propose" | "compose" | "select" | "reflect"

/** Which editor role produced a stage. */
export type HarnessStageDimension = "INV" | "DOM" | "AGG" | "COMPOSE"

export type HarnessStepStatus =
  "pending" | "running" | "succeeded" | "failed" | "interrupted" | "skipped"

/** One validation outcome on a rollout. */
export interface HarnessValidationResult {
  check: string
  passed: boolean
  /** `inconclusive` checks (no evidence either way) never count as passed. */
  status: "passed" | "failed" | "inconclusive"
  detail?: string
}

/** A side-effecting call a probe tried and was denied. */
export interface HarnessBlockedAction {
  toolName: string
  reason: string
}

export interface HarnessDeliverable {
  path: string
  /** UTF-8 text, capped; binary files keep only size and hash. */
  text?: string
  bytes: number
  sha256?: string
  truncated?: boolean
}

export interface HarnessExecutionMetrics {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd?: number
  latencyMs: number
  toolCalls: number
  toolFailures: number
  steps: number
}

/** Everything one rollout produced that later stages and people may inspect. */
export interface HarnessExecutionEvidence {
  snapshotId: string
  /** Hash of the task inputs the rollout saw. */
  inputFingerprint: string
  /** Runtime + isolation facts: app version, runtime kind, model, workspace base. */
  environmentFingerprint: string
  /** Final assistant text, capped. */
  output: string
  /** `[ACTION]` / `[OBSERVATION]` / `[ERROR]` rendering of the whole run, capped per observation. */
  trajectory: string
  deliverables: HarnessDeliverable[]
  metrics: HarnessExecutionMetrics
  validation: HarnessValidationResult[]
  blockedActions: HarnessBlockedAction[]
  /** Subagent / dispatch calls seen in the trajectory. */
  delegations: string[]
  /** True when the run degraded (no tools, text-only host). */
  degraded: boolean
  /** True when the run produced what the task asked for. */
  delivered: boolean
  error?: string
  /** Trace id of the run's spans, when tracing captured it. */
  traceId?: string
}

export interface HarnessEvolutionStep {
  /** `<runId>:<label>` */
  id: string
  runId: string
  label: string
  kind: HarnessStepKind
  dim?: HarnessStageDimension
  round?: number
  status: HarnessStepStatus
  /** Rollouts: the harness rolled. Stages: the harness produced. */
  snapshotId?: string
  /** Rollouts only. */
  evidence?: HarnessExecutionEvidence
  /** Stages: the editor's notes (`<notes>` block). */
  notes?: string
  /** Stages: the editor left the harness unchanged. */
  keptBase?: boolean
  /** Stages: the proposal was invalid twice and the stage inherited its input. */
  fellBack?: boolean
  attempts: number
  error?: string
  costUsd?: number
  inputTokens: number
  outputTokens: number
  modelCalls: number
  /** Rollouts: the step whose evidence was reused, and the key it matched. */
  cacheHitOf?: string
  cacheKey?: string
  startedAt?: number
  endedAt?: number
  updatedAt: number
}
