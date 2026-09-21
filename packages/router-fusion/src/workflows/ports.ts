/**
 * Ports the workflow graphs run against (DESIGN §3: "模块不能直接绕过 runtime
 * 调用模型或 shell"). A workflow never talks to a provider, a database or a
 * clock directly; the host supplies these, and tests supply the deterministic
 * Fake Provider and the in-memory ledger.
 */

import type {
  EvidenceRef,
  JudgeReport,
  Message,
  RunEventType,
  VerificationReport,
} from "../contracts/schemas"
import type { BudgetRefusalCode } from "../ledger/planner"
import type { RawUsage, UsageSemantics } from "../usage/normalize"

export type RoleCallErrorClass =
  /** The provider explicitly refused to accept the request (429 / overloaded before processing). */
  | "rate_limited"
  /** The provider answered with a server error; nothing billable was produced. */
  | "server_error"
  /** Connect/DNS/TLS failure: the request never left. */
  | "not_sent"
  /** The request was sent and no answer arrived: outcome and bill are unknowable. */
  | "timeout_after_send"
  /** The model or provider refused on policy/safety grounds. */
  | "refusal"
  | "invalid_request"
  | "auth"
  | "cancelled"

export interface RoleCallRequest {
  runId: string
  logicalStepId: string
  attemptId: string
  role: string
  deploymentId: string
  messages: Message[]
  maxOutputTokens: number
  /** Ask for a JSON document matching this schema (validated by the workflow, not trusted). */
  jsonSchema?: Record<string, unknown>
  /** Tool policy id; null means no tools. */
  toolPolicyId: string | null
  /**
   * The tools the model may REQUEST under that policy. The executor offers
   * them without an implementation: a tool call comes back as a request, and
   * the workflow decides what the runtime executes (DESIGN §11).
   */
  tools?: ToolDescriptor[]
  /** Deliver partial text as it arrives (direct mode only; never for fusion candidates). */
  onDelta?: (text: string) => void
}

export type RoleCallResponse =
  | {
      outcome: "ok"
      text: string
      usage: RawUsage
      semantics: UsageSemantics
      providerRequestId: string | null
      finishReason: "stop" | "length" | "tool_calls"
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    }
  | {
      outcome: "error"
      errorClass: RoleCallErrorClass
      message: string
      retryAfterMs?: number
      /** Usage the provider still reported (e.g. a refusal after partial generation). */
      usage?: RawUsage
      semantics?: UsageSemantics
      providerRequestId?: string | null
    }

export interface RoleCallExecutor {
  call(request: RoleCallRequest, signal: AbortSignal): Promise<RoleCallResponse>
}

/** The committed result a replay returns instead of calling again (INV-04). */
export interface CommittedCallResult {
  text: string
  providerRequestId: string | null
  finishReason: "stop" | "length" | "tool_calls"
  /**
   * What the model asked to run, when this call ended on a tool request. It is
   * part of the committed result because a replay has to hand the workflow the
   * same requests the first attempt got: without them a resumed run sees a
   * tool-call step with no calls, and the step's work is lost (REC-03).
   */
  toolCalls?: ToolIntent[]
}

export type PrepareOutcome =
  | { kind: "granted"; attemptId: string; attemptNo: number }
  | { kind: "replay"; result: CommittedCallResult }
  | {
      kind: "refused"
      code:
        | BudgetRefusalCode
        | "RUN_NOT_RUNNING"
        | "FENCED"
        | "DEADLINE_EXCEEDED"
        | "REVOKED"
        | "ATTEMPTS_EXHAUSTED"
        /**
         * An earlier attempt of this step was sent and never answered. The step
         * is not re-sent after a crash or a replay: its outcome belongs to
         * reconciliation, not to a second bill (INV-05, REC-03).
         */
        | "STEP_OUTCOME_UNKNOWN"
    }

export interface PrepareCallInput {
  logicalStepId: string
  role: string
  deploymentId: string
  reserveMicrousd: number
  /** Convert an existing stage reservation instead of reserving new money. */
  fromStageId?: string
  requestHash: string
}

export interface SettleCallInput {
  status: "succeeded" | "failed"
  usage: RawUsage | null
  semantics: UsageSemantics | null
  providerRequestId: string | null
  /** Stored for replay when the call succeeded. */
  result?: CommittedCallResult
  errorClass?: RoleCallErrorClass
}

export interface SettleOutcome {
  actualMicrousd: number
  frozen: boolean
  costStatus: "actual" | "estimated" | "pending"
}

export interface CallLedgerPort {
  prepare(input: PrepareCallInput): Promise<PrepareOutcome>
  /** Must be durable BEFORE a byte is sent. */
  markDispatched(attemptId: string): Promise<void>
  settle(attemptId: string, input: SettleCallInput): Promise<SettleOutcome>
  /** Sent, no answer: keep the reservation, never retry this attempt. */
  markUnknown(attemptId: string, reason: string): Promise<void>
  /** Proved never sent: release the reservation and the model-call slot. */
  abandon(attemptId: string): Promise<void>
  reserveStage(
    stageId: string,
    amountMicrousd: number
  ): Promise<{ kind: "granted" } | { kind: "refused"; code: BudgetRefusalCode | "RUN_NOT_RUNNING" }>
  releaseStage(stageId: string): Promise<void>
}

export interface WorkflowEvent {
  type: RunEventType | "run.degraded" | "candidate.rejected" | "verification.requested"
  payload: Record<string, unknown>
}

export interface EventSink {
  emit(event: WorkflowEvent): Promise<void>
}

export interface Clock {
  now(): number
}

export interface StoredArtifact {
  artifactId: string
  contentSha256: string
  sizeBytes: number
  mediaType: string
}

export interface ArtifactStore {
  put(content: string, mediaType: string, namespace: string): Promise<StoredArtifact>
  get(artifactId: string): Promise<{ content: string; artifact: StoredArtifact } | null>
}

export interface JudgeParseResult {
  report: JudgeReport | null
  error?: string
}

// ── tools (DESIGN §11) ────────────────────────────────────────────────────────

/**
 * `read_only` reads files or sources; `sandbox_write` changes an isolated
 * workspace; `external_write` publishes. A panel may only read; nothing in this
 * build may write outside a sandbox.
 */
export type ToolClass = "read_only" | "sandbox_write" | "external_write"

export interface ToolDescriptor {
  name: string
  description: string
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>
  toolClass: ToolClass
}

/** What a model asked for. A request, never an execution (roles-1 common rules). */
export interface ToolIntent {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolContext {
  runId: string
  logicalStepId: string
  policyId: string
  role: string
  signal: AbortSignal
}

export type ToolReceiptStatus = "succeeded" | "refused" | "failed"

export interface ToolReceipt {
  /** Stable per (step, tool, canonical arguments); a repeat returns the stored receipt. */
  operationId: string
  toolCallId: string
  name: string
  status: ToolReceiptStatus
  /** Why the runtime would not run it, when refused (policy, SSRF, path escape…). */
  refusalCode?: string
  /** What the tool read, content-pinned, when it read something. */
  evidence: EvidenceRef[]
  /**
   * What the model is shown: an excerpt, the full references and a truncation
   * note. It is untrusted data and is fenced as such wherever it is quoted.
   */
  summary: string
}

export interface ToolRuntime {
  /** The tools a policy offers; an unknown policy offers none. */
  describe(policyId: string): ToolDescriptor[]
  /** Authorize, validate, execute and record one requested tool call. Never throws a refusal. */
  execute(intent: ToolIntent, context: ToolContext): Promise<ToolReceipt>
}

// ── evidence (DESIGN §9.3, INV-12) ────────────────────────────────────────────

export type EvidenceRejection =
  /** No such artifact in this tenant (or in this run's reach — the same answer). */
  | "missing"
  /** It exists but this run may not cite it. */
  | "not_readable"
  /** The content no longer hashes to what the reference pinned. */
  | "hash_mismatch"
  /** Its content window has passed. */
  | "expired"
  | "malformed"

export type EvidenceCheck = { ok: true } | { ok: false; reason: EvidenceRejection }

export interface EvidenceResolver {
  resolve(ref: EvidenceRef): Promise<EvidenceCheck>
}

export type { VerificationReport }
