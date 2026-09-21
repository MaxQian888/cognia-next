/**
 * Delegate workflow (DESIGN §10, ADR-0188 B4):
 *
 *   PLAN → WORK(subtask 1..N) → VERIFY → [REPAIR|TAKEOVER → VERIFY] → [REVIEW] → DELIVER
 *
 * PLAN — the lead (baseline) reads the task contract, a listing of the
 * workspace at its base revision, the tools and the acceptance profile, and
 * drafts between one and `delegate_subtasks` (≤ 4) Subtasks, each with its own
 * goal, allowed paths, constraints, acceptance criteria and step bound. The
 * server reviews the draft before anything is delegated: paths are normalised
 * and refused when they escape, name the root or a credential directory; the
 * base revision, tool policy, task ids and artifact namespaces are the
 * runtime's, never the model's; each step bound is clamped to the worker's
 * turn ceiling. A lead that needs input or is blocked ends the run
 * explicitly; nothing is delegated on a guess.
 *
 * WORK — the subtasks run in order on the evolving revision: subtask k reads
 * the revision subtask k−1 produced, and its patch is staged on top of what
 * came before. Every session runs under policy `delegate-work-1` — read, list,
 * propose a patch — and every hard counter is the RUN's, not the session's:
 * worker turns (≤ 8), tool operations (≤ 12), model calls, money and the
 * deadline are shared by all subtasks and every repair or takeover. A proposal
 * inside the subtask's allowed paths is recorded; one outside them waits for a
 * person through the ApprovalPort (kind `scope_expansion`, bound to that
 * subtask's task id, its path set and its base revision) — the worker has no
 * way to approve, a denial fails the run, and an undecided request parks it
 * (DEL-07). Past a limit a tool request is refused, not run.
 *
 * VERIFY — the acceptance profile runs once on the FINAL combined revision, in
 * the sandbox. Only that runtime report can verify: the workers'
 * `claimed_check_ids` are recorded and never counted (DEL-01), a report about
 * another revision is `inconclusive` (DEL-03), and a green exit over zero
 * tests is a failure (DEL-02, `code-acceptance.ts`).
 *
 * REPAIR / TAKEOVER — bounded by `worker_repair_rounds` (≤ 1) and
 * `lead_takeovers` (≤ 1) for the whole run, spent in that order wherever the
 * run first needs one: on a subtask that could not finish, or on a combined
 * change that failed its acceptance. Both continue from the failing state with
 * the objective failure report — the repair as the worker, the takeover as the
 * lead. When both are spent the run fails with `VERIFICATION_FAILED`, or —
 * only when the last verification was inconclusive and the request allowed it
 * — delivers a degraded patch (DEL-06). Nothing loops.
 *
 * REVIEW — with a reviewer role, a billed model review of a verified change.
 * Its check is `executed_by: model`; it can fail a result, never pass one the
 * sandbox did not pass, and a failed review escalates like any other failure.
 *
 * DELIVER — `patch_only` by default: the combined patch is an artifact and the
 * user's workspace is untouched. `workspace_updated` only when the request
 * asked for it, after a person approved exactly this patch on exactly this
 * base (`workspace_apply`), through a compare-and-swap that refuses — never
 * overwrites — a workspace that moved (`PATCH_CONFLICT`, DEL-04).
 *
 * Every model call is a durable logical step (`performDurableCall`) and every
 * other step goes through the step journal under an id that carries the
 * subtask it belongs to, so a run that resumes after an approval, or after a
 * crash, replays exactly what it did instead of doing it again; a side effect
 * that was dispatched and never answered is UNKNOWN and is never re-run
 * (REC-06). Money moves only through the CallLedger.
 */

import { z } from "zod"

import {
  CONTRACT_SCHEMA_VERSION,
  SubtaskSchema,
  WorkerResultSchema,
  type Message,
  type RunResult,
  type Subtask,
  type TaskKind,
  type VerificationCheck,
  type VerificationReport,
  type WorkerResult,
} from "../contracts/schemas"
import { DELEGATE_LIMIT_CEILINGS, SUBTASK_MAX_STEPS, type ActionLimits } from "../config/types"
import { estimateTokens } from "../routing/features"
import {
  judgeRuntimeAcceptance,
  type AcceptanceVerdict,
  type SandboxTier,
} from "../verify/code-acceptance"
import { acceptanceClaimFor } from "../verify/profiles"
import { parseJsonDocument } from "../verify/text-verifiers"
import { canonicalHash, sha256Hex, uuidFromName } from "../util/sha256"
import { REVIEW_SCHEMA } from "./answer-verifier"
import { compactionDecision, compactTranscript, transcriptTokens } from "./context-window"
import {
  DELEGATE_PATCH_LIMITS,
  DELEGATE_TOOL_NAMES,
  DELEGATE_WORK_POLICY,
  DelegateToolArgs,
  IDEMPOTENT_SIDE_EFFECTS,
  buildDelegatePatch,
  delegateApprovalDigest,
  delegatePatchSha256,
  normalizeDelegatePath,
  patchBytes,
  pathInScope,
  type AcceptancePort,
  type AcceptanceRunOutcome,
  type ApplyPatchResult,
  type ApprovalPort,
  type DelegateApprovalDecision,
  type DelegateApprovalKind,
  type DelegateApprovalSummary,
  type DelegatePatch,
  type DelegatePatchEdit,
  type DelegateSideEffectKind,
  type DelegateStepJournal,
  type DelegateToolRuntime,
  type StagePatchResult,
  type WorkspacePort,
} from "./delegate-ports"
import {
  BudgetRefusedError,
  WorkflowError,
  performDurableCall,
  type DurableCallPorts,
  type DurableCallResult,
} from "./durable-call"
import type { ArtifactStore, ToolDescriptor, ToolIntent, ToolReceipt } from "./ports"
import { roleMessages, taskContract, untrustedBlock } from "./prompting"

export const DELEGATE_VERIFIER_VERSION = "delegate-verify-1"
/** Money for the plan and the first worker turn, held before either is sent. */
export const DELEGATE_CORE_STAGE = "delegate:core"
/** Files of the base revision the lead sees listed. */
export const DELEGATE_SNAPSHOT_FILES = 200
/** Paths one subtask may name. */
export const DELEGATE_MAX_ALLOWED_PATHS = 32

/** System prompt and framing per call, in every reservation. */
const OVERHEAD_TOKENS = 1_500
/** The subtask and the session notes a worker turn carries on top of the task. */
const SUBTASK_TOKENS = 1_000
/** The tool descriptors offered with a turn. */
const TOOLS_TOKENS = 400
/** Bytes of a file's base content the reviewer is shown. */
const REVIEW_EXCERPT_BYTES = 4_000
/** Characters of the change the reviewer is shown in all. */
const REVIEW_MATERIAL_CHARS = 40_000
const COMPACTION_SUMMARY_TOKENS = 2_048

const FORMAT_REPAIR_INSTRUCTION =
  "The previous answer did not match the required JSON schema. Return only a JSON document that matches the schema; change nothing else."

export type DelegateAttemptKind = "work" | "repair" | "takeover"
export type DelegateDelivery = "patch_only" | "workspace_updated"

export interface DelegateRole {
  deploymentId: string
  contextLimit: number
}

export interface DelegateLimits {
  /** Subtasks the lead may plan (≤ 4). */
  maxSubtasks: number
  /** Model turns for the whole run — every subtask, repair and takeover shares them (≤ 8). */
  workerModelTurns: number
  /** Tool operations for the whole run (≤ 12). */
  workerToolOperations: number
  /** Worker repair rounds for the whole run (≤ 1). */
  workerRepairRounds: number
  /** Lead takeovers for the whole run, once the repairs are spent (≤ 1). */
  leadTakeovers: number
  /** Structured-output repairs for the whole run. */
  maxFormatRepairs: number
  transportAttempts: number
}

/** An action's limits, as the delegate graph reads them. */
export function delegateLimitsOf(limits: ActionLimits): DelegateLimits {
  return {
    maxSubtasks: limits.delegate_subtasks ?? DELEGATE_LIMIT_CEILINGS.delegate_subtasks,
    workerModelTurns: limits.worker_model_turns,
    workerToolOperations: limits.worker_tool_operations,
    workerRepairRounds: limits.worker_repair_rounds,
    leadTakeovers: limits.lead_takeovers,
    maxFormatRepairs: limits.max_format_repairs,
    transportAttempts: limits.transport_attempts_per_call,
  }
}

export interface DelegateRunPorts extends DurableCallPorts {
  artifacts: ArtifactStore
  newId: () => string
  tools: DelegateToolRuntime
  workspace: WorkspacePort
  acceptance: AcceptancePort
  approvals: ApprovalPort
  journal: DelegateStepJournal
}

export interface DelegateRunInput {
  runId: string
  lead: DelegateRole
  worker: DelegateRole
  /** Reviews a verified change when set (the optional `reviewer` role). */
  reviewer?: DelegateRole
  messages: Message[]
  /** The `.cognia/workspace.json` acceptance profile the sandbox runs. */
  acceptanceProfileId: string
  outputTokens: { lead: number; worker: number; reviewer: number }
  /** The per-call reservation for a role, given its worst-case input and output. */
  reserveFor: (
    role: string,
    deploymentId: string,
    inputTokens: number,
    outputTokens: number
  ) => number
  limits: DelegateLimits
  task: TaskKind
  allowDegraded: boolean
  /** `patch_only` unless the caller asked for the approval-gated apply. */
  delivery: DelegateDelivery
  deadlineAt: number
  signal: AbortSignal
}

export type DelegateSessionOutcome =
  /** The session finished and its patch was staged: the run moved on. */
  | "staged"
  /** The session ended without a result: turns spent or output invalid. */
  | "incomplete"
  /** The worker (or lead) said it cannot go on. */
  | "blocked"
  /** The runtime would not stage the patch. */
  | "patch_refused"

export interface DelegateAttemptSummary {
  attempt: number
  kind: DelegateAttemptKind
  role: "worker" | "lead"
  /** The planned subtask (1-based), or null for a fix after a failed verification. */
  subtask: number | null
  taskId: string
  turns: number
  toolOperations: number
  outcome: DelegateSessionOutcome
  reason: string | null
  baseRevision: string
  resultRevision: string | null
  /** The session's own patch, against its base revision. */
  patchArtifactId: string | null
}

export interface DelegateVerificationSummary {
  round: number
  /** The combined revision this round verified. */
  revision: string
  status: "passed" | "failed" | "inconclusive"
  reason: string | null
  reportId: string | null
  sandboxTier: SandboxTier | null
  review: VerificationCheck | null
}

export interface DelegatePendingApproval {
  approvalId: string
  kind: DelegateApprovalKind
  requestDigest: string
  revision: string
  logicalStepId: string
  args: Record<string, unknown>
  summary: DelegateApprovalSummary
}

export interface DelegateRunStats {
  /** Every Subtask the runtime issued: the plan's, then a fix subtask per repaired round. */
  subtasks: Subtask[]
  attempts: DelegateAttemptSummary[]
  verifications: DelegateVerificationSummary[]
  repairs: number
  takeovers: number
  /** Model turns and tool operations the whole run spent. */
  turns: number
  toolOperations: number
  formatRepairs: number
  /** Paths a person approved beyond the subtasks' allowed paths. */
  scopeExpansions: string[]
}

export type DelegateRunOutcome =
  | (DelegateRunStats & {
      kind: "completed"
      result: RunResult
      /** One per staged session, in order; the last produced the delivered revision. */
      workerResults: WorkerResult[]
      workerResult: WorkerResult
      /** The combined patch against the run's base revision. */
      patchArtifactId: string
      /** The staged revision the acceptance report is about. */
      resultRevision: string
      /** The user's workspace revision after `workspace_updated`; null for `patch_only`. */
      deliveredRevision: string | null
      sandboxTier: SandboxTier | null
      acceptanceReport: VerificationReport | null
    })
  | (DelegateRunStats & {
      /** A person must decide; the host parks the run and resumes it with the same input. */
      kind: "waiting_for_approval"
      approval: DelegatePendingApproval
    })

// ── model-facing output schemas ───────────────────────────────────────────────

const PLAN_SUBTASK_SCHEMA = {
  type: "object",
  required: ["goal", "allowed_paths", "constraints", "acceptance", "max_steps"],
  additionalProperties: false,
  properties: {
    goal: { type: "string" },
    allowed_paths: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    acceptance: { type: "array", items: { type: "string" } },
    max_steps: { type: "integer" },
  },
} as const

export const DELEGATE_PLAN_SCHEMA = {
  type: "object",
  required: ["status", "subtasks", "questions"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ready", "need_input", "blocked"] },
    subtasks: { type: "array", items: PLAN_SUBTASK_SCHEMA },
    questions: { type: "array", items: { type: "string" } },
  },
} as const

export const DELEGATE_WORKER_OUTPUT_SCHEMA = {
  type: "object",
  required: ["status", "summary", "claimed_check_ids", "open_questions"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    claimed_check_ids: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
  },
} as const

const PlanSubtask = z.object({
  goal: z.string(),
  allowed_paths: z.array(z.string()),
  constraints: z.array(z.string()),
  acceptance: z.array(z.string()),
  max_steps: z.int().min(1).max(SUBTASK_MAX_STEPS),
})
type PlanSubtaskValue = z.infer<typeof PlanSubtask>

const LeadPlan = z.object({
  status: z.enum(["ready", "need_input", "blocked"]),
  subtasks: z.array(PlanSubtask),
  questions: z.array(z.string()),
})

const WorkerOutput = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string().trim().min(1),
  claimed_check_ids: z.array(z.string()),
  open_questions: z.array(z.string()),
})
type WorkerOutputValue = z.infer<typeof WorkerOutput>

const ReviewOutput = z.object({
  status: z.enum(["passed", "failed", "inconclusive"]),
  issues: z.array(z.string()),
})

const RecordedIntents = z.object({
  tool_calls: z.array(
    z.object({ id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) })
  ),
  lost: z.boolean(),
})

// ── helpers ───────────────────────────────────────────────────────────────────

/** A dispatched side effect that never answered: reconciliation, never a re-run (REC-06). */
export class SideEffectOutcomeUnknownError extends WorkflowError {
  constructor(stepId: string, kind: DelegateSideEffectKind, cause?: string) {
    super(
      "SIDE_EFFECT_OUTCOME_UNKNOWN",
      `step ${stepId} (${kind}) was dispatched and its outcome is unknown`,
      { logical_step_id: stepId, side_effect: kind, ...(cause ? { cause } : {}) }
    )
    this.name = "SideEffectOutcomeUnknownError"
  }
}

function refusedReceipt(intent: ToolIntent, code: string): ToolReceipt {
  return {
    operationId: `refused:${intent.id}`,
    toolCallId: intent.id,
    name: intent.name,
    status: "refused",
    refusalCode: code,
    evidence: [],
    summary: `refused: ${code}`,
  }
}

function receiptText(receipts: readonly ToolReceipt[]): string {
  return receipts
    .map((receipt) =>
      [
        `tool ${receipt.name} (${receipt.toolCallId}): ${receipt.status}${receipt.refusalCode ? ` — ${receipt.refusalCode}` : ""}`,
        receipt.summary,
      ].join("\n")
    )
    .join("\n\n")
}

function runtimeCheck(
  check_id: string,
  kind: string,
  status: VerificationCheck["status"],
  summary: string
): VerificationCheck {
  return { check_id, kind, status, summary, executed_by: "runtime", artifact_refs: [] }
}

function aggregate(checks: readonly VerificationCheck[]): VerificationReport["status"] {
  if (checks.some((c) => c.status === "failed")) return "failed"
  if (checks.some((c) => c.status === "inconclusive")) return "inconclusive"
  return "passed"
}

/** A verdict built from a runtime report the workflow may believe (passed, failed, or a believable inconclusive). */
function believable(verdict: AcceptanceVerdict | null): boolean {
  if (!verdict) return false
  return verdict.status !== "inconclusive" || verdict.reason === "ACCEPTANCE_INCONCLUSIVE"
}

function acceptanceFailureText(verdict: AcceptanceVerdict, revision: string): string {
  const head =
    verdict.status === "failed"
      ? "VERIFICATION_FAILED"
      : `VERIFICATION_INCONCLUSIVE (${verdict.status === "inconclusive" ? verdict.reason : "unknown"})`
  const lines = [
    `${head}: acceptance of revision ${revision}${verdict.report ? `, report ${verdict.report.report_id}` : ""}`,
  ]
  if (verdict.status === "inconclusive" && verdict.reason === "REVISION_MISMATCH") {
    lines.push(
      `the report is about revision ${verdict.report?.revision ?? "none"}, not ${revision}`
    )
  }
  if (verdict.report && believable(verdict)) {
    lines.push(
      ...verdict.report.checks
        .filter((check) => check.status === "failed" || check.status === "inconclusive")
        .slice(0, 30)
        .map((check) => `${check.check_id} (${check.kind}): ${check.status} — ${check.summary}`)
    )
  }
  return lines.join("\n")
}

function listPaths(paths: Iterable<string>): string {
  const all = [...paths]
  return all.length > 0 ? all.join(", ") : "(none)"
}

interface AttemptSpec {
  attempt: number
  kind: DelegateAttemptKind
  role: "worker" | "lead"
}

/** Where the run's change stands: the edits against the run's base, and the revision that holds them. */
interface WorkState {
  edits: Map<string, DelegatePatchEdit>
  revision: string
}

/** One subtask (or one fix round) and the state its sessions start from. */
interface Target {
  /** `s1`… for a planned subtask, `fix1`… for a fix after a failed verification. */
  prefix: string
  index: number | null
  contract: Subtask
  start: WorkState
}

/** What a session inherits: the run's edits so far, what this chain already proposed, and its notes. */
interface Carried {
  edits: Map<string, DelegatePatchEdit>
  own: Set<string>
  readRevision: string
  notes: string[]
}

interface SessionRecord extends AttemptSpec {
  target: Target
  turns: number
  toolOperations: number
  outcome: DelegateSessionOutcome
  reason: string | null
  failureText: string
  output: WorkerOutputValue | null
  edits: Map<string, DelegatePatchEdit>
  own: Set<string>
  resultRevision: string | null
  refusedPath: string | null
  patchArtifactId: string | null
  workerResult: WorkerResult | null
}

interface VerificationRound {
  round: number
  revision: string
  verdict: AcceptanceVerdict
  review: VerificationCheck | null
  status: "passed" | "failed" | "inconclusive"
  reason: string | null
  failureText: string
  patch: DelegatePatch
  patchSha256: string
  patchArtifactId: string
}

type SessionResult =
  | {
      kind: "finished"
      output: WorkerOutputValue
      edits: Map<string, DelegatePatchEdit>
      own: Set<string>
      turns: number
      toolOperations: number
    }
  | {
      kind: "incomplete"
      reason: "WORKER_TURN_LIMIT" | "WORKER_OUTPUT_INVALID"
      edits: Map<string, DelegatePatchEdit>
      own: Set<string>
      turns: number
      toolOperations: number
    }
  | { kind: "waiting"; approval: DelegatePendingApproval; turns: number; toolOperations: number }

function clampLimits(limits: DelegateLimits): DelegateLimits {
  const positive = (value: number, name: string) => {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new WorkflowError("LIMITS_INVALID", `${name} must be a positive integer`, {
        limit: name,
      })
    return value
  }
  const nonNegative = (value: number, name: string) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new WorkflowError("LIMITS_INVALID", `${name} must be a non-negative integer`, {
        limit: name,
      })
    return value
  }
  return {
    maxSubtasks: Math.min(
      positive(limits.maxSubtasks, "maxSubtasks"),
      DELEGATE_LIMIT_CEILINGS.delegate_subtasks
    ),
    workerModelTurns: Math.min(
      positive(limits.workerModelTurns, "workerModelTurns"),
      DELEGATE_LIMIT_CEILINGS.worker_model_turns
    ),
    workerToolOperations: Math.min(
      positive(limits.workerToolOperations, "workerToolOperations"),
      DELEGATE_LIMIT_CEILINGS.worker_tool_operations
    ),
    workerRepairRounds: Math.min(
      nonNegative(limits.workerRepairRounds, "workerRepairRounds"),
      DELEGATE_LIMIT_CEILINGS.worker_repair_rounds
    ),
    leadTakeovers: Math.min(
      nonNegative(limits.leadTakeovers, "leadTakeovers"),
      DELEGATE_LIMIT_CEILINGS.lead_takeovers
    ),
    maxFormatRepairs: nonNegative(limits.maxFormatRepairs, "maxFormatRepairs"),
    transportAttempts: positive(limits.transportAttempts, "transportAttempts"),
  }
}

/** The tools the policy offers that the delegate graph knows; anything else is not offered. */
function offeredTools(tools: DelegateToolRuntime): ToolDescriptor[] {
  return tools.describe(DELEGATE_WORK_POLICY).filter((tool) => {
    if (tool.name === DELEGATE_TOOL_NAMES.proposePatch) return tool.toolClass === "sandbox_write"
    return (
      (tool.name === DELEGATE_TOOL_NAMES.read || tool.name === DELEGATE_TOOL_NAMES.list) &&
      tool.toolClass === "read_only"
    )
  })
}

// ── the workflow ──────────────────────────────────────────────────────────────

export async function runDelegateWorkflow(
  ports: DelegateRunPorts,
  rawInput: DelegateRunInput
): Promise<DelegateRunOutcome> {
  const input = { ...rawInput, limits: clampLimits(rawInput.limits) }
  const { limits } = input
  const contract = taskContract(input.messages)
  const taskTokens = estimateTokens(contract)
  const namespace = `runs/${input.runId}/delegate`

  let formatRepairs = 0
  let attemptCounter = 0
  let repairsUsed = 0
  let takeoversUsed = 0
  let turnsUsed = 0
  let toolOperationsUsed = 0
  const issued: Subtask[] = []
  const subtaskArtifacts: string[] = []
  const sessions: SessionRecord[] = []
  const verifications: VerificationRound[] = []
  /** Paths a person approved, per subtask task id. */
  const approvedScope = new Map<string, string[]>()

  const allApprovedPaths = (): string[] => [
    ...new Set([...approvedScope.values()].flatMap((paths) => paths)),
  ]

  const stats = (): DelegateRunStats => ({
    subtasks: [...issued],
    attempts: sessions.map((record) => ({
      attempt: record.attempt,
      kind: record.kind,
      role: record.role,
      subtask: record.target.index,
      taskId: record.target.contract.task_id,
      turns: record.turns,
      toolOperations: record.toolOperations,
      outcome: record.outcome,
      reason: record.reason,
      baseRevision: record.target.start.revision,
      resultRevision: record.resultRevision,
      patchArtifactId: record.patchArtifactId,
    })),
    verifications: verifications.map((round) => ({
      round: round.round,
      revision: round.revision,
      status: round.status,
      reason: round.reason,
      reportId: round.verdict.report?.report_id ?? null,
      sandboxTier: round.verdict.tier,
      review: round.review,
    })),
    repairs: repairsUsed,
    takeovers: takeoversUsed,
    turns: turnsUsed,
    toolOperations: toolOperationsUsed,
    formatRepairs,
    scopeExpansions: allApprovedPaths(),
  })

  const checkLive = () => {
    if (input.signal.aborted) throw new WorkflowError("CANCELLED", "the run was cancelled")
    if (ports.clock.now() >= input.deadlineAt)
      throw new WorkflowError("DEADLINE_EXCEEDED", "the run deadline passed")
  }

  const phase = (step: string, extra: Record<string, unknown> = {}) =>
    ports.events.emit({ type: "phase.changed", payload: { phase: "delegate", step, ...extra } })

  /** One non-model step, durably: replayed when committed, never re-run when its outcome is unknown. */
  const journaled = async <T>(
    stepId: string,
    kind: DelegateSideEffectKind,
    requestHash: string,
    run: () => Promise<T>
  ): Promise<T> => {
    const begun = await ports.journal.begin({ stepId, kind, requestHash })
    if (begun.kind === "replay") return begun.receipt as T
    if (begun.kind === "mismatch") {
      throw new WorkflowError(
        "STEP_REPLAY_MISMATCH",
        `step ${stepId} was recorded with a different request`,
        { logical_step_id: stepId }
      )
    }
    if (begun.kind === "unknown" && !IDEMPOTENT_SIDE_EFFECTS.has(kind)) {
      throw new SideEffectOutcomeUnknownError(stepId, kind)
    }
    checkLive()
    await ports.journal.markDispatched(stepId)
    let receipt: T
    try {
      receipt = await run()
    } catch (error) {
      if (IDEMPOTENT_SIDE_EFFECTS.has(kind)) throw error
      if (error instanceof WorkflowError && error.code === "CANCELLED") throw error
      throw new SideEffectOutcomeUnknownError(
        stepId,
        kind,
        error instanceof Error ? error.message : String(error)
      )
    }
    await ports.journal.commit(stepId, receipt)
    return receipt
  }

  const call = (
    role: string,
    deploymentId: string,
    logicalStepId: string,
    messages: Message[],
    options: {
      reserve: number
      stageId?: string
      maxOutputTokens: number
      jsonSchema?: Record<string, unknown>
      tools?: ToolDescriptor[]
    }
  ): Promise<DurableCallResult> =>
    performDurableCall(ports, {
      runId: input.runId,
      logicalStepId,
      role,
      deploymentId,
      reserveMicrousd: options.reserve,
      ...(options.stageId ? { fromStageId: options.stageId } : {}),
      transportAttempts: limits.transportAttempts,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
      request: {
        messages,
        maxOutputTokens: options.maxOutputTokens,
        ...(options.jsonSchema ? { jsonSchema: options.jsonSchema } : {}),
        toolPolicyId: options.tools && options.tools.length > 0 ? DELEGATE_WORK_POLICY : null,
        ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
      },
    })

  /** A structured call with the run's shared format repair. Null when it stayed invalid. */
  const callForJson = async <T>(
    role: string,
    deploymentId: string,
    logicalStepId: string,
    messages: Message[],
    schema: Record<string, unknown>,
    parser: z.ZodType<T>,
    options: { reserve: number; stageId?: string; maxOutputTokens: number }
  ): Promise<T | null> => {
    const parse = (text: string): T | null => {
      const document = parseJsonDocument(text)
      if (!document.ok) return null
      const parsed = parser.safeParse(document.value)
      return parsed.success ? parsed.data : null
    }
    const first = await call(role, deploymentId, logicalStepId, messages, {
      ...options,
      jsonSchema: schema,
    })
    const value = parse(first.text)
    if (value !== null || formatRepairs >= limits.maxFormatRepairs) return value
    formatRepairs++
    const repaired = await call(
      role,
      deploymentId,
      `${logicalStepId}:format_repair`,
      [
        ...messages,
        { role: "assistant", content: first.text.length > 0 ? first.text : "(empty)" },
        { role: "user", content: FORMAT_REPAIR_INSTRUCTION },
      ],
      { reserve: options.reserve, maxOutputTokens: options.maxOutputTokens, jsonSchema: schema }
    )
    return parse(repaired.text)
  }

  /** Ask a person, bound to a digest. The answer must be about this digest, or nothing proceeds. */
  const askApproval = async (
    kind: DelegateApprovalKind,
    args: Record<string, unknown>,
    revision: string,
    meta: {
      logicalStepId: string
      requestedBy: "worker" | "lead" | "runtime"
      summary: DelegateApprovalSummary
    }
  ): Promise<{ decision: DelegateApprovalDecision; pending: DelegatePendingApproval }> => {
    const requestDigest = delegateApprovalDigest(kind, args, revision)
    const decision = await ports.approvals.requestApproval({
      runId: input.runId,
      logicalStepId: meta.logicalStepId,
      kind,
      requestDigest,
      revision,
      args,
      summary: meta.summary,
      requestedBy: meta.requestedBy,
    })
    if (decision.requestDigest !== requestDigest) {
      throw new WorkflowError("APPROVAL_MISMATCH", "the approval answers a different request", {
        kind,
        request_digest: requestDigest,
        answered_digest: decision.requestDigest,
      })
    }
    const pending: DelegatePendingApproval = {
      approvalId: decision.approvalId,
      kind,
      requestDigest,
      revision,
      logicalStepId: meta.logicalStepId,
      args,
      summary: meta.summary,
    }
    if (decision.status === "waiting") {
      await ports.events.emit({
        type: "approval.required",
        payload: {
          approval_id: decision.approvalId,
          kind,
          request_digest: requestDigest,
          revision,
          logical_step_id: meta.logicalStepId,
          paths: meta.summary.paths.length,
        },
      })
      await phase("waiting_for_approval", { kind, approval_id: decision.approvalId })
    } else {
      await phase("approval_resolved", {
        kind,
        status: decision.status,
        approval_id: decision.approvalId,
      })
    }
    return { decision, pending }
  }

  const offered = offeredTools(ports.tools)
  if (!offered.some((tool) => tool.name === DELEGATE_TOOL_NAMES.proposePatch)) {
    throw new WorkflowError(
      "DELEGATE_TOOLS_UNAVAILABLE",
      `the ${DELEGATE_WORK_POLICY} tool policy offers no patch proposal; a worker could not change anything`
    )
  }
  checkLive()

  // ── PLAN: the base revision, pinned once for the whole run ──
  await phase("plan")
  const base = await journaled(
    "delegate:base_revision",
    "base_revision",
    canonicalHash({ step: "delegate:base_revision", run: input.runId }),
    async () => ({ revision: await ports.workspace.currentRevision() })
  )
  const baseRevision = base.revision
  const listing = await ports.workspace.listFiles({
    prefix: "",
    revision: baseRevision,
    limit: DELEGATE_SNAPSHOT_FILES,
  })
  const snapshot = listing.ok
    ? [
        ...listing.files.map((file) => `${file.path} (${file.sizeBytes} B)`),
        ...(listing.truncated ? ["… (more files not listed)"] : []),
      ].join("\n") || "(the workspace is empty)"
    : `(the workspace listing is unavailable: ${listing.code})`
  const planMessages = roleMessages("lead", {
    contract,
    material: [
      untrustedBlock("the workspace snapshot", snapshot),
      [
        "Tool capabilities of the worker:",
        `- policy ${DELEGATE_WORK_POLICY}: ${offered.map((tool) => tool.name).join(", ")}`,
        `- the whole run has at most ${limits.workerModelTurns} model turns and ${limits.workerToolOperations} tool operations, shared by every subtask and by any repair`,
        "- writes only inside the allowed paths you set; anything else waits for a person's approval",
        "",
        "Verification profile:",
        `- ${input.acceptanceProfileId}: the runtime runs this acceptance command in a network-less sandbox on the final patched revision; only its report can accept the work`,
      ].join("\n"),
    ],
    runtimeNote: [
      `Planning phase. Return 1 to ${limits.maxSubtasks} subtasks as JSON, in the order they must run:`,
      "- status: ready, or need_input / blocked with questions;",
      "- each subtask: goal; allowed_paths (directories or files relative to the workspace root — never the root itself);",
      `  constraints; acceptance criteria; max_steps (1–${SUBTASK_MAX_STEPS}).`,
      "Split only where a later subtask genuinely builds on an earlier one: each reads the revision the previous produced, and they share the run's turn and tool budget.",
      "The runtime sets the base revisions, the tool policy and the ids, and runs the acceptance profile once on the final revision.",
    ].join("\n"),
  })
  const planReserve = input.reserveFor(
    "lead",
    input.lead.deploymentId,
    transcriptTokens(planMessages),
    input.outputTokens.lead
  )
  const firstTurnReserve = input.reserveFor(
    "worker",
    input.worker.deploymentId,
    OVERHEAD_TOKENS + taskTokens + SUBTASK_TOKENS + TOOLS_TOKENS,
    input.outputTokens.worker
  )
  let coreLeft = planReserve + firstTurnReserve
  const held = await ports.ledger.reserveStage(DELEGATE_CORE_STAGE, coreLeft)
  if (held.kind === "refused") throw new BudgetRefusedError(held.code)
  const fromCore = (amount: number): string | undefined => {
    if (coreLeft <= 0) return undefined
    coreLeft = Math.max(0, coreLeft - amount)
    return DELEGATE_CORE_STAGE
  }

  try {
    const plan = await callForJson(
      "lead",
      input.lead.deploymentId,
      "delegate:plan",
      planMessages,
      DELEGATE_PLAN_SCHEMA,
      LeadPlan,
      {
        reserve: planReserve,
        stageId: fromCore(planReserve),
        maxOutputTokens: input.outputTokens.lead,
      }
    )
    if (!plan) {
      throw new WorkflowError(
        "PLAN_INVALID",
        "the lead's plan stayed invalid after the allowed repair"
      )
    }
    if (plan.status !== "ready") {
      throw new WorkflowError(
        plan.status === "need_input" ? "DELEGATE_NEEDS_INPUT" : "DELEGATE_BLOCKED",
        plan.status === "need_input"
          ? "the lead needs more information before the work can be delegated"
          : "the lead reports the task cannot be delegated as asked",
        { questions: plan.questions.slice(0, 10) }
      )
    }
    if (plan.subtasks.length === 0 || plan.subtasks.length > limits.maxSubtasks) {
      throw new WorkflowError(
        "PLAN_INVALID",
        `a plan names between 1 and ${limits.maxSubtasks} subtasks`,
        { subtasks: plan.subtasks.length, max_subtasks: limits.maxSubtasks }
      )
    }
    /** The plan as the server reviewed it: normalised paths, trimmed text, clamped steps. */
    const drafts: PlanSubtaskValue[] = plan.subtasks.map((draft, index) => {
      const allowed: string[] = []
      for (const raw of draft.allowed_paths) {
        const normalized = normalizeDelegatePath(raw)
        if (!normalized.ok) {
          throw new WorkflowError("PLAN_INVALID", "the plan names a path the runtime refuses", {
            subtask: index + 1,
            path: raw,
            refusal: normalized.code,
          })
        }
        if (!allowed.includes(normalized.path)) allowed.push(normalized.path)
      }
      if (allowed.length === 0 || allowed.length > DELEGATE_MAX_ALLOWED_PATHS) {
        throw new WorkflowError(
          "PLAN_INVALID",
          `a subtask names between 1 and ${DELEGATE_MAX_ALLOWED_PATHS} allowed paths`,
          { subtask: index + 1, allowed_paths: allowed.length }
        )
      }
      if (draft.goal.trim().length === 0) {
        throw new WorkflowError("PLAN_INVALID", "a subtask has no goal", { subtask: index + 1 })
      }
      return {
        goal: draft.goal.trim(),
        allowed_paths: allowed,
        constraints: draft.constraints.map((c) => c.trim()).filter((c) => c.length > 0),
        acceptance: draft.acceptance.map((a) => a.trim()).filter((a) => a.length > 0),
        max_steps: Math.min(draft.max_steps, limits.workerModelTurns),
      }
    })
    await phase("planned", {
      subtasks: drafts.length,
      allowed_paths: drafts.reduce((sum, draft) => sum + draft.allowed_paths.length, 0),
      base_revision: baseRevision,
    })

    const issueSubtask = async (
      index: number,
      draft: PlanSubtaskValue,
      startRevision: string
    ): Promise<Subtask> => {
      const subtask = SubtaskSchema.parse({
        schema_version: CONTRACT_SCHEMA_VERSION,
        task_id: uuidFromName(`${input.runId}|delegate|subtask|${index}`),
        goal: draft.goal,
        base_revision: startRevision,
        allowed_paths: draft.allowed_paths,
        constraints: draft.constraints,
        acceptance: [`profile:${input.acceptanceProfileId}`, ...draft.acceptance],
        tool_policy_id: DELEGATE_WORK_POLICY,
        max_steps: draft.max_steps,
        artifact_namespace: `${namespace}/subtask-${index}`,
      })
      issued.push(subtask)
      subtaskArtifacts.push(
        (
          await ports.artifacts.put(
            JSON.stringify(subtask),
            "application/json",
            subtask.artifact_namespace
          )
        ).artifactId
      )
      return subtask
    }

    /** A fix round is a subtask the runtime writes itself: the whole change, in every scope the plan named. */
    const issueFixSubtask = async (round: number, startRevision: string): Promise<Subtask> => {
      const subtask = SubtaskSchema.parse({
        schema_version: CONTRACT_SCHEMA_VERSION,
        task_id: uuidFromName(`${input.runId}|delegate|fix|${round}`),
        goal: `Make the combined change of this run pass the acceptance profile ${input.acceptanceProfileId}. The planned subtasks were: ${drafts.map((draft, i) => `${i + 1}. ${draft.goal}`).join(" ")}`,
        base_revision: startRevision,
        allowed_paths: [
          ...new Set([...drafts.flatMap((draft) => draft.allowed_paths), ...allApprovedPaths()]),
        ],
        constraints: [...new Set(drafts.flatMap((draft) => draft.constraints))],
        acceptance: [
          `profile:${input.acceptanceProfileId}`,
          ...new Set(drafts.flatMap((draft) => draft.acceptance)),
        ],
        tool_policy_id: DELEGATE_WORK_POLICY,
        max_steps: limits.workerModelTurns,
        artifact_namespace: `${namespace}/fix-${round}`,
      })
      issued.push(subtask)
      subtaskArtifacts.push(
        (
          await ports.artifacts.put(
            JSON.stringify(subtask),
            "application/json",
            subtask.artifact_namespace
          )
        ).artifactId
      )
      return subtask
    }

    const scopeOf = (target: Target): string[] => [
      ...new Set([
        ...target.contract.allowed_paths,
        ...(approvedScope.get(target.contract.task_id) ?? []),
      ]),
    ]

    // ── WORK / REPAIR / TAKEOVER sessions ──
    const runSession = async (
      spec: AttemptSpec,
      target: Target,
      carried: Carried
    ): Promise<SessionResult> => {
      const deployment = spec.role === "lead" ? input.lead : input.worker
      const out = spec.role === "lead" ? input.outputTokens.lead : input.outputTokens.worker
      const turnsLeft = limits.workerModelTurns - turnsUsed
      if (turnsLeft <= 0) {
        // Every session shares the run's turns; with none left nothing can run,
        // and no repair or takeover could either.
        throw new WorkflowError(
          "DELEGATE_LIMIT_EXHAUSTED",
          `the run's ${limits.workerModelTurns} worker turns are spent before ${target.prefix} could work`,
          {
            limit: "worker_model_turns",
            used: turnsUsed,
            cap: limits.workerModelTurns,
            subtask: target.index,
            attempt: spec.attempt,
          }
        )
      }
      const maxTurns = Math.min(target.contract.max_steps, turnsLeft)
      const edits = new Map(carried.edits)
      const own = new Set(carried.own)
      let toolOperations = 0
      let turns = 0
      let epoch = 0
      const sessionStep = `delegate:${target.prefix}:${spec.kind}:${spec.attempt}`
      const budgetNote = (turn: number) => {
        const notes = [
          `Runtime budget: session turn ${turn} of ${maxTurns}; the run has used ${turnsUsed} of ${limits.workerModelTurns} worker turns and ${toolOperationsUsed} of ${limits.workerToolOperations} tool operations.`,
        ]
        if (turn + 1 === maxTurns)
          notes.push(
            "Your next turn is the last: no tools will be offered. Answer with the result JSON."
          )
        else if (toolOperationsUsed >= limits.workerToolOperations)
          notes.push("No tool operations are left. Answer with the result JSON.")
        return notes.join(" ")
      }
      const proposedNote = () => {
        const inherited = [...edits.keys()].filter((path) => !own.has(path))
        return [
          own.size > 0
            ? `Files this session proposed: ${[...own].map((path) => `${path} (${edits.get(path)?.action})`).join(", ")}`
            : "This session has proposed no file yet.",
          ...(inherited.length > 0
            ? [`Files earlier work already changed: ${listPaths(inherited)}`]
            : []),
        ].join("\n")
      }

      let transcript: Message[] = roleMessages("worker", {
        contract,
        material: [
          `The subtask the runtime issued (authoritative):\n${JSON.stringify(target.contract, null, 2)}`,
          ...carried.notes,
        ],
        runtimeNote: [
          "Runtime contract for this session:",
          spec.role === "lead"
            ? "- you are the lead, taking this work over after the worker's attempt failed; you do the work yourself"
            : "- you are the worker",
          `- you read the workspace at revision ${carried.readRevision}`,
          `- you may write only inside: ${scopeOf(target).join(", ")}`,
          `- at most ${maxTurns} model turns in this session, out of the run's remaining budget; past a limit requests are refused`,
          "- a proposal changes nothing until the runtime stages the patch and runs the acceptance profile; only that report counts, so never claim a test passed",
          "- finish with the result JSON: status completed or blocked, summary, claimed_check_ids, open_questions",
        ].join("\n"),
      })

      for (let turn = 1; turn <= maxTurns; turn++) {
        if (turn > 1) {
          const decision = compactionDecision({
            transcriptTokens: transcriptTokens(transcript) + out,
            contextLimit: deployment.contextLimit,
            pendingToolCalls: 0,
          })
          if (decision.compact) {
            const summaryTokens = Math.min(out, COMPACTION_SUMMARY_TOKENS)
            transcript = (
              await compactTranscript(ports, {
                runId: input.runId,
                logicalStepId: sessionStep,
                deploymentId: deployment.deploymentId,
                reserveMicrousd: input.reserveFor(
                  "compactor",
                  deployment.deploymentId,
                  transcriptTokens(transcript),
                  summaryTokens
                ),
                transportAttempts: limits.transportAttempts,
                deadlineAt: input.deadlineAt,
                signal: input.signal,
                taskState: {
                  goal: target.contract.goal,
                  constraints: [
                    ...target.contract.constraints,
                    `write only inside: ${scopeOf(target).join(", ")}`,
                    `acceptance: ${target.contract.acceptance.join("; ")}`,
                  ],
                  revision: carried.readRevision,
                },
                transcript,
                epoch,
                maxOutputTokens: summaryTokens,
              })
            ).messages
            epoch++
            transcript = [
              ...transcript,
              { role: "user", content: `${proposedNote()}\n${budgetNote(turn - 1)}` },
            ]
          }
        }

        const lastTurn = turn === maxTurns
        const offerTools = !lastTurn && toolOperationsUsed < limits.workerToolOperations
        const stepId = `${sessionStep}:turn:${turn}`
        turns = turn
        turnsUsed++
        await phase("turn", {
          attempt: spec.attempt,
          kind: spec.kind,
          role: spec.role,
          subtask: target.index,
          turn,
        })
        const tools = offerTools ? offered : undefined
        const response = await call(spec.role, deployment.deploymentId, stepId, transcript, {
          reserve: input.reserveFor(
            spec.role,
            deployment.deploymentId,
            transcriptTokens(transcript) + (tools ? TOOLS_TOKENS : 0),
            out
          ),
          ...(spec.attempt === 1 && turn === 1 ? { stageId: fromCore(firstTurnReserve) } : {}),
          maxOutputTokens: out,
          jsonSchema: DELEGATE_WORKER_OUTPUT_SCHEMA,
          ...(tools ? { tools } : {}),
        })

        if (response.finishReason === "tool_calls") {
          // A committed call replays its text, not its tool requests: the
          // journal keeps them, so a resumed session asks for the same tools.
          const recordId = `${stepId}:intents`
          const recorded = await journaled(
            recordId,
            "turn_intents",
            canonicalHash({ step: recordId }),
            async () => ({
              tool_calls: response.toolCalls ?? [],
              lost: response.replayed && !response.toolCalls,
            })
          )
          const intents = RecordedIntents.parse(recorded)
          const receipts: ToolReceipt[] = new Array(intents.tool_calls.length)
          const queue: Array<{
            index: number
            intent: ToolIntent
            patch?: { path: string; edit: DelegatePatchEdit }
          }> = []
          const outside: Array<{
            index: number
            intent: ToolIntent
            path: string
            edit: DelegatePatchEdit
          }> = []
          for (const [index, intent] of intents.tool_calls.entries()) {
            if (!offerTools) {
              receipts[index] = refusedReceipt(intent, "NO_TOOLS_OFFERED")
              continue
            }
            if (toolOperationsUsed >= limits.workerToolOperations) {
              receipts[index] = refusedReceipt(intent, "TOOL_OPERATION_LIMIT")
              continue
            }
            toolOperationsUsed++
            toolOperations++
            const tool = offered.find((candidate) => candidate.name === intent.name)
            if (!tool) {
              receipts[index] = refusedReceipt(intent, "TOOL_NOT_OFFERED")
              continue
            }
            if (tool.name !== DELEGATE_TOOL_NAMES.proposePatch) {
              queue.push({ index, intent })
              continue
            }
            const args = DelegateToolArgs.propose_patch.safeParse(intent.arguments)
            if (!args.success) {
              receipts[index] = refusedReceipt(intent, "INVALID_ARGUMENTS")
              continue
            }
            const normalized = normalizeDelegatePath(args.data.path)
            if (!normalized.ok) {
              receipts[index] = refusedReceipt(intent, normalized.code)
              continue
            }
            const edit: DelegatePatchEdit =
              args.data.action === "write"
                ? { action: "write", content: args.data.content }
                : { action: "delete" }
            const canonical: ToolIntent = {
              ...intent,
              arguments: { ...args.data, path: normalized.path },
            }
            if (pathInScope(normalized.path, scopeOf(target))) {
              queue.push({ index, intent: canonical, patch: { path: normalized.path, edit } })
            } else {
              outside.push({ index, intent: canonical, path: normalized.path, edit })
            }
          }

          if (outside.length > 0) {
            // DEL-07: a write outside this subtask's scope waits for a person,
            // bound to the subtask it was asked for.
            const paths = [...new Set(outside.map((entry) => entry.path))].sort()
            const { decision, pending } = await askApproval(
              "scope_expansion",
              { task_id: target.contract.task_id, paths },
              target.contract.base_revision,
              {
                logicalStepId: `${stepId}:scope`,
                requestedBy: spec.role,
                summary: {
                  paths,
                  fileCount: paths.length,
                  patchSha256: null,
                  patchArtifactId: null,
                },
              }
            )
            if (decision.status === "waiting") {
              return { kind: "waiting", approval: pending, turns, toolOperations }
            }
            if (decision.status === "denied") {
              throw new WorkflowError(
                "SCOPE_EXPANSION_DENIED",
                "a person refused a write outside the subtask's allowed paths",
                {
                  subtask: target.index,
                  task_id: target.contract.task_id,
                  paths,
                  approval_id: decision.approvalId,
                  reason: decision.reason,
                }
              )
            }
            const granted = approvedScope.get(target.contract.task_id) ?? []
            approvedScope.set(target.contract.task_id, [...new Set([...granted, ...paths])])
            queue.push(
              ...outside.map((entry) => ({
                index: entry.index,
                intent: entry.intent,
                patch: { path: entry.path, edit: entry.edit },
              }))
            )
            queue.sort((a, b) => a.index - b.index)
          }

          for (const item of queue) {
            if (item.patch) {
              const projected = new Map(edits)
              projected.set(item.patch.path, item.patch.edit)
              const fileBytes =
                item.patch.edit.action === "write"
                  ? new TextEncoder().encode(item.patch.edit.content).byteLength
                  : 0
              if (
                projected.size > DELEGATE_PATCH_LIMITS.maxFiles ||
                fileBytes > DELEGATE_PATCH_LIMITS.maxFileBytes ||
                patchBytes(projected) > DELEGATE_PATCH_LIMITS.maxTotalBytes
              ) {
                receipts[item.index] = refusedReceipt(item.intent, "PATCH_TOO_LARGE")
                continue
              }
            }
            const receipt = await ports.tools.execute(item.intent, {
              runId: input.runId,
              logicalStepId: stepId,
              policyId: DELEGATE_WORK_POLICY,
              role: spec.role,
              signal: input.signal,
              revision: carried.readRevision,
              allowedPaths: scopeOf(target),
            })
            receipts[item.index] = receipt
            if (item.patch && receipt.status === "succeeded") {
              edits.set(item.patch.path, item.patch.edit)
              own.add(item.patch.path)
            }
          }

          const admitted = receipts.filter(
            (receipt) =>
              receipt.refusalCode !== "NO_TOOLS_OFFERED" &&
              receipt.refusalCode !== "TOOL_OPERATION_LIMIT"
          ).length
          await phase("tools", {
            attempt: spec.attempt,
            subtask: target.index,
            turn,
            admitted,
            tools: receipts.map((receipt) => ({
              name: receipt.name,
              status: receipt.status,
              ...(receipt.refusalCode ? { refusal: receipt.refusalCode } : {}),
              operation_id: receipt.operationId,
            })),
          })
          transcript = [
            ...transcript,
            {
              role: "assistant",
              content:
                intents.tool_calls.length > 0
                  ? `Requested tools: ${intents.tool_calls.map((intent) => intent.name).join(", ")}`
                  : "Requested tools.",
            },
            {
              role: "user",
              content: [
                intents.lost
                  ? "The runtime could not recover the tool requests of your previous turn; request them again if you still need them."
                  : untrustedBlock("the tool results", receiptText(receipts)),
                proposedNote(),
                budgetNote(turn),
              ].join("\n\n"),
            },
          ]
          continue
        }

        const document = parseJsonDocument(response.text)
        const parsed = document.ok ? WorkerOutput.safeParse(document.value) : null
        if (parsed?.success) {
          return { kind: "finished", output: parsed.data, edits, own, turns, toolOperations }
        }
        if (lastTurn || formatRepairs >= limits.maxFormatRepairs) {
          return {
            kind: "incomplete",
            reason: "WORKER_OUTPUT_INVALID",
            edits,
            own,
            turns,
            toolOperations,
          }
        }
        formatRepairs++
        transcript = [
          ...transcript,
          { role: "assistant", content: response.text.length > 0 ? response.text : "(empty)" },
          { role: "user", content: FORMAT_REPAIR_INSTRUCTION },
        ]
      }
      return { kind: "incomplete", reason: "WORKER_TURN_LIMIT", edits, own, turns, toolOperations }
    }

    /** Stage what a finished session produced, or record why it produced nothing. */
    const finishSession = async (
      spec: AttemptSpec,
      target: Target,
      session: Exclude<SessionResult, { kind: "waiting" }>
    ): Promise<SessionRecord> => {
      const record: SessionRecord = {
        ...spec,
        target,
        turns: session.turns,
        toolOperations: session.toolOperations,
        outcome: "incomplete",
        reason: null,
        failureText: "",
        output: null,
        edits: session.edits,
        own: session.own,
        resultRevision: null,
        refusedPath: null,
        patchArtifactId: null,
        workerResult: null,
      }
      if (session.kind === "incomplete") {
        return {
          ...record,
          outcome: "incomplete",
          reason: session.reason,
          failureText: `${session.reason}: the attempt ended without a result after ${session.turns} turn(s) and ${session.toolOperations} tool operation(s); the run has used ${turnsUsed} of ${limits.workerModelTurns} turns and ${toolOperationsUsed} of ${limits.workerToolOperations} tool operations`,
        }
      }
      const output = session.output
      if (output.status === "blocked") {
        return {
          ...record,
          outcome: "blocked",
          reason: "WORKER_BLOCKED",
          output,
          failureText: [
            "WORKER_BLOCKED: the previous attempt stopped and reported it could not go on.",
            `its summary: ${output.summary}`,
            ...output.open_questions.slice(0, 10).map((q) => `open question: ${q}`),
          ].join("\n"),
        }
      }

      // The run's whole change so far, staged on the run's base revision.
      const combined = buildDelegatePatch(baseRevision, session.edits)
      const combinedSha = delegatePatchSha256(combined)
      const stageStep = `delegate:${target.prefix}:stage:${spec.attempt}`
      const staged = await journaled<StagePatchResult>(stageStep, "stage_patch", combinedSha, () =>
        ports.workspace.stagePatch({
          runId: input.runId,
          logicalStepId: stageStep,
          patch: combined,
          signal: input.signal,
        })
      )
      if (!staged.ok) {
        return {
          ...record,
          output,
          outcome: "patch_refused",
          reason: staged.code,
          refusedPath: staged.path,
          failureText: `${staged.code}: the runtime refused to stage the patch${staged.path ? ` at ${staged.path}` : ""}: ${staged.message}`,
        }
      }

      // What this session itself changed, against the revision it started from.
      const ownEdits = new Map(
        [...session.own]
          .filter((path) => session.edits.has(path))
          .map((path) => [path, session.edits.get(path) as DelegatePatchEdit])
      )
      const ownPatch = buildDelegatePatch(target.start.revision, ownEdits)
      const ownArtifact = await ports.artifacts.put(
        JSON.stringify(ownPatch),
        "application/json",
        `${target.contract.artifact_namespace}/patch`
      )
      const workerResult = WorkerResultSchema.parse({
        schema_version: CONTRACT_SCHEMA_VERSION,
        task_id: target.contract.task_id,
        summary: output.summary,
        base_revision: target.start.revision,
        result_revision: staged.revision,
        patch_artifact_id: ownArtifact.artifactId,
        claimed_check_ids: output.claimed_check_ids,
        open_questions: output.open_questions,
      })
      await phase("staged", {
        attempt: spec.attempt,
        subtask: target.index,
        files: combined.files.length,
        own_files: ownPatch.files.length,
        revision: staged.revision,
      })
      return {
        ...record,
        output,
        outcome: "staged",
        resultRevision: staged.revision,
        patchArtifactId: ownArtifact.artifactId,
        workerResult,
      }
    }

    /** The next repair or takeover the run may still spend, in that order. */
    const nextEscalation = (): { kind: DelegateAttemptKind; role: "worker" | "lead" } | null => {
      if (repairsUsed < limits.workerRepairRounds) {
        repairsUsed++
        return { kind: "repair", role: "worker" }
      }
      if (takeoversUsed < limits.leadTakeovers) {
        takeoversUsed++
        return { kind: "takeover", role: "lead" }
      }
      return null
    }

    type ChainResult =
      | { kind: "done"; state: WorkState }
      | { kind: "waiting"; approval: DelegatePendingApproval }
      /** Nothing staged and no repair or takeover left. */
      | { kind: "exhausted"; record: SessionRecord }

    /** Work one target until a session stages, or the run's escalations run out. */
    const runChain = async (
      target: Target,
      first: { kind: DelegateAttemptKind; role: "worker" | "lead" },
      carried: Carried
    ): Promise<ChainResult> => {
      let spec = first
      let carry = carried
      for (;;) {
        const attempt = ++attemptCounter
        await phase("attempt", {
          attempt,
          kind: spec.kind,
          role: spec.role,
          subtask: target.index,
          target: target.prefix,
        })
        const session = await runSession({ attempt, ...spec }, target, carry)
        if (session.kind === "waiting") return { kind: "waiting", approval: session.approval }
        const record = await finishSession({ attempt, ...spec }, target, session)
        sessions.push(record)
        await phase("attempt_result", {
          attempt,
          kind: spec.kind,
          subtask: target.index,
          outcome: record.outcome,
          reason: record.reason,
          turns: record.turns,
          tool_operations: record.toolOperations,
        })
        if (record.outcome === "staged") {
          return {
            kind: "done",
            state: { edits: record.edits, revision: record.resultRevision as string },
          }
        }
        const escalation = nextEscalation()
        if (!escalation) return { kind: "exhausted", record }

        // The next attempt continues from the failing state — minus whatever
        // the runtime refused to stage, which it would only refuse again.
        const kept = new Map(record.edits)
        const own = new Set(record.own)
        if (record.outcome === "patch_refused") {
          if (record.refusedPath) {
            kept.delete(record.refusedPath)
            own.delete(record.refusedPath)
          } else {
            kept.clear()
            for (const [path, edit] of target.start.edits) kept.set(path, edit)
            own.clear()
          }
        }
        await phase(escalation.kind, {
          attempt: attemptCounter + 1,
          subtask: target.index,
          reason: record.reason,
        })
        carry = {
          edits: kept,
          own,
          readRevision: record.resultRevision ?? carry.readRevision,
          notes: [
            untrustedBlock(
              "the objective failure report of the previous attempt",
              record.failureText
            ),
            [
              escalation.kind === "takeover"
                ? "The previous attempts did not pass; you are the lead and do this work yourself."
                : "Fix what failed, inside the allowed paths.",
              target.index !== null
                ? `You continue subtask ${target.index} from revision ${record.resultRevision ?? carry.readRevision}.`
                : `You continue the combined change from revision ${record.resultRevision ?? carry.readRevision}.`,
              `Files already in the patch: ${listPaths(kept.keys())}.`,
            ].join(" "),
          ],
        }
        spec = escalation
      }
    }

    const reviewChange = async (
      round: number,
      patch: DelegatePatch,
      report: VerificationReport
    ): Promise<VerificationCheck> => {
      const reviewer = input.reviewer as DelegateRole
      const sections: string[] = []
      let used = 0
      for (const file of patch.files) {
        if (used >= REVIEW_MATERIAL_CHARS) {
          sections.push(`… ${patch.files.length - sections.length} more file(s) not shown`)
          break
        }
        const before = await ports.workspace.readFile({
          path: file.path,
          revision: baseRevision,
          maxBytes: REVIEW_EXCERPT_BYTES,
        })
        const beforeText = before.ok
          ? `${before.content}${before.truncated ? "\n… (truncated)" : ""}`
          : before.code === "NOT_FOUND"
            ? "(the file does not exist at the base revision)"
            : `(unavailable: ${before.code})`
        const after =
          file.action === "delete"
            ? "(deleted)"
            : `${(file.content ?? "").slice(0, REVIEW_EXCERPT_BYTES)}${(file.content ?? "").length > REVIEW_EXCERPT_BYTES ? "\n… (truncated)" : ""}`
        const section = [
          `### ${file.path} (${file.action})`,
          "--- before",
          beforeText,
          "+++ after",
          after,
        ].join("\n")
        used += section.length
        sections.push(section)
      }
      const messages = roleMessages("reviewer", {
        contract,
        material: [
          untrustedBlock(
            "the rubric",
            JSON.stringify(
              {
                subtasks: issued.map((subtask) => ({
                  goal: subtask.goal,
                  constraints: subtask.constraints,
                  acceptance: subtask.acceptance,
                })),
              },
              null,
              2
            )
          ),
          untrustedBlock("the change under review", sections.join("\n\n") || "(an empty patch)"),
          untrustedBlock(
            "the runtime check results",
            report.checks
              .map((check) => `${check.check_id}: ${check.status} — ${check.summary}`)
              .join("\n")
          ),
          "Return JSON: status passed, failed or inconclusive, and the issues you found.",
        ],
      })
      await ports.events.emit({
        type: "phase.changed",
        payload: { phase: "review", round },
      })
      const verdict = await callForJson(
        "reviewer",
        reviewer.deploymentId,
        `delegate:review:${round}`,
        messages,
        REVIEW_SCHEMA,
        ReviewOutput,
        {
          reserve: input.reserveFor(
            "reviewer",
            reviewer.deploymentId,
            transcriptTokens(messages),
            input.outputTokens.reviewer
          ),
          maxOutputTokens: input.outputTokens.reviewer,
        }
      )
      return {
        check_id: "model_review",
        kind: "review",
        status: verdict ? verdict.status : "inconclusive",
        summary: verdict
          ? verdict.issues.length > 0
            ? verdict.issues.slice(0, 5).join("; ")
            : "no issues reported"
          : "the review output was not valid",
        executed_by: "model",
        artifact_refs: [],
      }
    }

    /** VERIFY: the acceptance profile on the combined revision, then the optional review. */
    const verifyState = async (round: number, state: WorkState): Promise<VerificationRound> => {
      const patch = buildDelegatePatch(baseRevision, state.edits)
      const patchSha256 = delegatePatchSha256(patch)
      const patchArtifact = await ports.artifacts.put(
        JSON.stringify(patch),
        "application/json",
        `${namespace}/patch-${round}`
      )
      await ports.events.emit({
        type: "phase.changed",
        payload: { phase: "verification", step: "acceptance", round, revision: state.revision },
      })
      const verifyStep = `delegate:verify:${round}`
      const run = await journaled<AcceptanceRunOutcome>(
        verifyStep,
        "acceptance_run",
        canonicalHash({ profile: input.acceptanceProfileId, revision: state.revision }),
        () =>
          ports.acceptance.runProfile({
            runId: input.runId,
            logicalStepId: verifyStep,
            profileId: input.acceptanceProfileId,
            revision: state.revision,
            signal: input.signal,
          })
      )
      if (run.kind === "refused") {
        // No sandbox, no profile, no approval for the command: not a quality
        // failure, so no worker is asked to repair it.
        throw new WorkflowError(run.code, run.message, { round, revision: state.revision })
      }
      const verdict = judgeRuntimeAcceptance(run.report, state.revision)
      let review: VerificationCheck | null = null
      if (verdict.status === "passed" && input.reviewer && verdict.report) {
        review = await reviewChange(round, patch, verdict.report)
      }
      const status: VerificationRound["status"] =
        verdict.status === "passed"
          ? review === null || review.status === "passed"
            ? "passed"
            : review.status === "failed"
              ? "failed"
              : "inconclusive"
          : verdict.status
      const reason =
        verdict.status !== "passed"
          ? verdict.reason
          : review && review.status !== "passed"
            ? review.status === "failed"
              ? "REVIEW_FAILED"
              : "REVIEW_INCONCLUSIVE"
            : null
      await ports.events.emit({
        type: "verification.completed",
        payload: {
          stage: `verify:${round}`,
          round,
          status,
          level: verdict.report?.level ?? "none",
          ...(verdict.report ? { report_id: verdict.report.report_id } : {}),
          ...(verdict.tier ? { tier: verdict.tier } : {}),
          revision: state.revision,
          ...(reason ? { reason } : {}),
        },
      })
      const failureText =
        verdict.status !== "passed"
          ? acceptanceFailureText(verdict, state.revision)
          : `${reason}: the content review of revision ${state.revision} did not pass — ${review?.summary ?? ""}`
      return {
        round,
        revision: state.revision,
        verdict,
        review,
        status,
        reason,
        failureText,
        patch,
        patchSha256,
        patchArtifactId: patchArtifact.artifactId,
      }
    }

    // ── WORK: the subtasks, in order, on the evolving revision ──
    let state: WorkState = { edits: new Map(), revision: baseRevision }
    for (const [index, draft] of drafts.entries()) {
      const number = index + 1
      const subtask = await issueSubtask(number, draft, state.revision)
      await phase("subtask", {
        subtask: number,
        of: drafts.length,
        base_revision: state.revision,
        max_steps: subtask.max_steps,
      })
      const target: Target = {
        prefix: `s${number}`,
        index: number,
        contract: subtask,
        start: { edits: new Map(state.edits), revision: state.revision },
      }
      const chain = await runChain(
        target,
        { kind: "work", role: "worker" },
        {
          edits: new Map(state.edits),
          own: new Set(),
          readRevision: state.revision,
          notes:
            number > 1
              ? [
                  `Subtask ${number} of ${drafts.length}. The earlier subtasks already changed: ${listPaths(state.edits.keys())}. You read revision ${state.revision}, which contains them.`,
                ]
              : [],
        }
      )
      if (chain.kind === "waiting") {
        return { kind: "waiting_for_approval", approval: chain.approval, ...stats() }
      }
      if (chain.kind === "exhausted") {
        throw new WorkflowError(
          "VERIFICATION_FAILED",
          `subtask ${number} of ${drafts.length} could not be completed, and every repair and takeover is spent`,
          {
            subtask: number,
            subtasks: drafts.length,
            attempts: sessions.length,
            repairs: repairsUsed,
            takeovers: takeoversUsed,
            last_outcome: chain.record.outcome,
            last_reason: chain.record.reason,
          }
        )
      }
      state = chain.state
      await phase("subtask_done", { subtask: number, revision: state.revision })
    }

    // ── VERIFY on the final combined revision, with bounded fixes ──
    let round = 0
    let accepted: VerificationRound | null = null
    let degraded = false
    for (;;) {
      round++
      const verification = await verifyState(round, state)
      verifications.push(verification)
      if (verification.status === "passed") {
        accepted = verification
        break
      }
      const escalation = nextEscalation()
      const degradable = verification.status === "inconclusive" && input.allowDegraded
      if (!escalation) {
        if (degradable) {
          accepted = verification
          degraded = true
          break
        }
        throw new WorkflowError(
          verification.status === "inconclusive"
            ? "VERIFICATION_INCONCLUSIVE"
            : "VERIFICATION_FAILED",
          verification.status === "inconclusive"
            ? "the combined change could not be verified, and the request did not allow a degraded result"
            : "the delegated work did not pass its acceptance after every repair and takeover",
          {
            round,
            attempts: sessions.length,
            repairs: repairsUsed,
            takeovers: takeoversUsed,
            last_outcome: verification.status,
            last_reason: verification.reason,
            ...(verification.verdict.report
              ? { report_id: verification.verdict.report.report_id }
              : {}),
            patch_artifact_id: verification.patchArtifactId,
            result_revision: verification.revision,
          }
        )
      }
      const fix = await issueFixSubtask(round, state.revision)
      const target: Target = {
        prefix: `fix${round}`,
        index: null,
        contract: fix,
        start: { edits: new Map(state.edits), revision: state.revision },
      }
      await phase(escalation.kind, {
        attempt: attemptCounter + 1,
        round,
        reason: verification.reason,
      })
      const chain = await runChain(target, escalation, {
        edits: new Map(state.edits),
        own: new Set(),
        readRevision: state.revision,
        notes: [
          untrustedBlock("the objective failure report", verification.failureText),
          `The combined change of every subtask is staged at revision ${state.revision}: ${listPaths(state.edits.keys())}. Make it pass the acceptance profile, inside the allowed paths.`,
        ],
      })
      if (chain.kind === "waiting") {
        return { kind: "waiting_for_approval", approval: chain.approval, ...stats() }
      }
      if (chain.kind === "exhausted") {
        // The fix produced nothing new: the last verification is the result.
        if (degradable) {
          accepted = verification
          degraded = true
          break
        }
        throw new WorkflowError(
          verification.status === "inconclusive"
            ? "VERIFICATION_INCONCLUSIVE"
            : "VERIFICATION_FAILED",
          "the delegated work did not pass its acceptance, and no repair or takeover is left",
          {
            round,
            attempts: sessions.length,
            repairs: repairsUsed,
            takeovers: takeoversUsed,
            last_outcome: chain.record.outcome,
            last_reason: chain.record.reason,
            ...(verification.verdict.report
              ? { report_id: verification.verdict.report.report_id }
              : {}),
            patch_artifact_id: verification.patchArtifactId,
            result_revision: verification.revision,
          }
        )
      }
      state = chain.state
    }

    // ── DELIVER ──
    const final = accepted as VerificationRound
    const stagedSessions = sessions.filter((record) => record.outcome === "staged")
    const workerResults = stagedSessions.map((record) => record.workerResult as WorkerResult)
    const lastWorkerResult = workerResults.at(-1) as WorkerResult
    const verification = composeDelegateReport(ports.newId(), final, workerResults)
    const warnings: string[] = []
    let delivery: DelegateDelivery = "patch_only"
    let deliveredRevision: string | null = null
    if (input.delivery === "workspace_updated" && degraded) {
      warnings.push("workspace_apply_skipped_unverified")
    } else if (input.delivery === "workspace_updated") {
      const paths = final.patch.files.map((file) => file.path)
      const { decision, pending } = await askApproval(
        "workspace_apply",
        { patch_sha256: final.patchSha256, paths },
        baseRevision,
        {
          logicalStepId: "delegate:deliver",
          requestedBy: "runtime",
          summary: {
            paths,
            fileCount: paths.length,
            patchSha256: final.patchSha256,
            patchArtifactId: final.patchArtifactId,
          },
        }
      )
      if (decision.status === "waiting") {
        return { kind: "waiting_for_approval", approval: pending, ...stats() }
      }
      if (decision.status === "denied") {
        warnings.push("workspace_apply_declined")
      } else {
        const applyStep = "delegate:deliver:apply"
        const applied = await journaled<ApplyPatchResult>(
          applyStep,
          "workspace_apply",
          canonicalHash({
            patch: final.patchSha256,
            base: baseRevision,
            approval: decision.approvalId,
          }),
          () =>
            ports.workspace.applyPatchCAS({
              runId: input.runId,
              logicalStepId: applyStep,
              patch: final.patch,
              baseRevision,
              approvalId: decision.approvalId,
              signal: input.signal,
            })
        )
        if (!applied.ok) {
          throw new WorkflowError(
            applied.code,
            applied.code === "PATCH_CONFLICT"
              ? "the workspace moved since the patch's base revision; nothing was written"
              : `the runtime refused to apply the patch: ${applied.message}`,
            {
              base_revision: baseRevision,
              ...(applied.code === "PATCH_CONFLICT"
                ? { current_revision: applied.currentRevision }
                : { path: applied.path }),
              patch_artifact_id: final.patchArtifactId,
            }
          )
        }
        delivery = "workspace_updated"
        deliveredRevision = applied.revision
      }
    }

    const answer = stagedSessions
      .map((record) => (record.output as WorkerOutputValue).summary.trim())
      .join("\n\n")
    const answerArtifact = await ports.artifacts.put(
      answer,
      "text/markdown",
      `runs/${input.runId}/answer`
    )
    const workerResultArtifact = await ports.artifacts.put(
      JSON.stringify(workerResults),
      "application/json",
      `${namespace}/worker-results`
    )
    const claims = workerResults.reduce((sum, result) => sum + result.claimed_check_ids.length, 0)
    const openQuestions = workerResults.reduce(
      (sum, result) => sum + result.open_questions.length,
      0
    )
    warnings.push(
      ...(drafts.length > 1 ? [`subtasks:${drafts.length}`] : []),
      ...(repairsUsed > 0 ? [`repaired:${repairsUsed}`] : []),
      ...(takeoversUsed > 0 ? ["taken_over_by_lead"] : []),
      ...(allApprovedPaths().length > 0 ? ["scope_expanded_with_approval"] : []),
      ...(final.patch.files.length === 0 ? ["patch_empty"] : []),
      ...(claims > 0 ? ["worker_claims_not_counted"] : []),
      ...(openQuestions > 0 ? ["open_questions"] : []),
      ...(degraded ? [`verification_inconclusive:${final.reason ?? "UNKNOWN"}`] : []),
      ...(formatRepairs > 0 ? ["format_repaired"] : [])
    )
    if (degraded) {
      await ports.events.emit({
        type: "run.degraded",
        payload: {
          reason: "VERIFICATION_INCONCLUSIVE",
          mode_executed: "delegate",
          report_id: verification.report_id,
        },
      })
    }
    await phase("delivered", {
      round: final.round,
      delivery,
      files: final.patch.files.length,
      subtasks: drafts.length,
      revision: deliveredRevision ?? final.revision,
    })
    const acceptanceArtifacts = believable(final.verdict)
      ? (final.verdict.report?.artifact_refs ?? [])
      : []
    const result: RunResult = {
      answer,
      answer_artifact_id: answerArtifact.artifactId,
      answer_sha256: sha256Hex(answer),
      mode_executed: "delegate",
      quality_status: acceptanceClaimFor({
        verificationStatus: verification.status,
        profile: "code_fixture",
        task: input.task,
        deliversChange: true,
        degraded,
      }),
      verification,
      delivery,
      artifact_ids: [
        ...new Set([
          answerArtifact.artifactId,
          final.patchArtifactId,
          workerResultArtifact.artifactId,
          ...stagedSessions.map((record) => record.patchArtifactId as string),
          ...subtaskArtifacts,
          ...acceptanceArtifacts,
        ]),
      ],
      warnings,
    }
    return {
      kind: "completed",
      result,
      workerResults,
      workerResult: lastWorkerResult,
      patchArtifactId: final.patchArtifactId,
      resultRevision: final.revision,
      deliveredRevision,
      sandboxTier: final.verdict.tier,
      acceptanceReport: final.verdict.report,
      ...stats(),
    }
  } finally {
    await ports.ledger.releaseStage(DELEGATE_CORE_STAGE)
  }
}

/**
 * The run's verification report: the sandbox's own checks when the runtime
 * report may be believed, the workflow's checks on top — the revision match
 * (DEL-03), the verdict, the workers' claims recorded as not counted (DEL-01)
 * and the review. `tool_verified` only for a passed runtime verdict.
 */
function composeDelegateReport(
  reportId: string,
  round: VerificationRound,
  workerResults: readonly WorkerResult[]
): VerificationReport {
  const { verdict } = round
  const acceptance = verdict.report
  const checks: VerificationCheck[] = []
  if (acceptance && believable(verdict)) checks.push(...acceptance.checks)
  const revisionMatches = acceptance?.revision === round.revision
  checks.push(
    runtimeCheck(
      "revision_match",
      "revision",
      revisionMatches ? "passed" : "inconclusive",
      `report=${acceptance?.revision ?? "none"} result=${round.revision}`
    )
  )
  checks.push(
    runtimeCheck(
      "acceptance_verdict",
      "acceptance",
      verdict.status,
      `verdict=${verdict.status} reason=${verdict.status !== "passed" ? verdict.reason : "none"} tier=${verdict.tier ?? "none"}`
    )
  )
  checks.push(
    runtimeCheck(
      "worker_claims",
      "claims",
      "not_applicable",
      `claimed=${workerResults.reduce((sum, result) => sum + result.claimed_check_ids.length, 0)} — a claim is not evidence; only the runtime report counts`
    )
  )
  checks.push(
    runtimeCheck(
      "subtasks",
      "plan",
      "not_applicable",
      `staged=${workerResults.length} final=${round.revision}`
    )
  )
  if (round.review) checks.push(round.review)
  const toolPassed = verdict.status === "passed"
  const level: VerificationReport["level"] = toolPassed
    ? round.review
      ? "mixed"
      : "tool_verified"
    : round.review
      ? "model_review"
      : "schema_only"
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    report_id: reportId,
    status: aggregate(checks),
    level,
    checks,
    revision: round.revision,
    verifier_version: DELEGATE_VERIFIER_VERSION,
    artifact_refs: [
      ...new Set([
        round.patchArtifactId,
        ...(acceptance && believable(verdict) ? acceptance.artifact_refs : []),
      ]),
    ],
  }
}
