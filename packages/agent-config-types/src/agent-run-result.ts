// Authoritative non-stream result of one headless agent run (ADR-0090).
//
// `AgentRunResultV1` is what `--output-format json` prints as its ONE object,
// what `--output-format stream-json` appends after the canonical envelopes, and
// what the `@cognia/agent` SDK's `run()` resolves to. It is the only public
// non-stream shape: the old sparse `{type:"result"}` JSONL line is gone.
//
// Everything here is serialisable and secret-free — credentials appear as
// profile references only, exactly like the execution spec.

import type { AgentCapabilityId } from "./agent-execution"
import type { SessionFidelity, SessionLossReport } from "./canonical-session"
import { SESSION_FIDELITY_LEVELS } from "./canonical-session"
import { isNonEmptyString } from "./ref-safety"

// ---- Error vocabulary -------------------------------------------------------

/**
 * Stable, machine-matchable failure codes. CLI, SDK and RPC all speak these —
 * an integrator branches on `code`, never on `message`.
 */
export type AgentErrorCode =
  /** Flags/config/protocol the caller got wrong. Exit 2. */
  | "usage_error"
  | "config_error"
  | "protocol_error"
  /** A hard `requires` capability the selected backend does not have. Exit 4. */
  | "unsupported_capability"
  /** Another writable process holds the session lease. Exit 4. */
  | "session_locked"
  /** A model turn is already active on this session. Exit 4. */
  | "session_busy"
  | "session_not_found"
  /** Approval or resource trust said no. Exit 3. */
  | "permission_denied"
  | "resource_untrusted"
  /** Provider/transport/runtime failure. Exit 1. */
  | "provider_error"
  | "transport_error"
  | "runtime_error"
  | "tool_error"
  /** Deadlines and signals. */
  | "timeout"
  | "idle_timeout"
  | "cancelled"
  | "interrupted"

export const AGENT_ERROR_CODES: readonly AgentErrorCode[] = [
  "usage_error",
  "config_error",
  "protocol_error",
  "unsupported_capability",
  "session_locked",
  "session_busy",
  "session_not_found",
  "permission_denied",
  "resource_untrusted",
  "provider_error",
  "transport_error",
  "runtime_error",
  "tool_error",
  "timeout",
  "idle_timeout",
  "cancelled",
  "interrupted",
]

export interface AgentStructuredError {
  code: AgentErrorCode
  message: string
  /** True only for failures a caller could sensibly re-drive itself. */
  retryable?: boolean
  /** Capability that was missing (`unsupported_capability` only). */
  capability?: AgentCapabilityId
  /** Free-form, secret-free detail bag for operators. */
  detail?: Record<string, unknown>
}

// ---- Exit codes -------------------------------------------------------------

/**
 * Process exit codes, standardized across `run`, `rpc` and the SDK's CLI
 * shims. `124`/`130`/`143` follow the POSIX conventions callers already script
 * against (`timeout(1)`, 128+SIGINT, 128+SIGTERM).
 */
export const AGENT_EXIT_CODES = {
  success: 0,
  runtimeFailure: 1,
  usage: 2,
  denied: 3,
  conflict: 4,
  timeout: 124,
  sigint: 130,
  sigterm: 143,
} as const

export type AgentExitCode = (typeof AGENT_EXIT_CODES)[keyof typeof AGENT_EXIT_CODES]

/** Map a structured error onto its process exit code. */
export function exitCodeForError(error: AgentStructuredError | undefined): AgentExitCode {
  if (!error) return AGENT_EXIT_CODES.success
  switch (error.code) {
    case "usage_error":
    case "config_error":
    case "protocol_error":
      return AGENT_EXIT_CODES.usage
    case "permission_denied":
    case "resource_untrusted":
      return AGENT_EXIT_CODES.denied
    case "unsupported_capability":
    case "session_locked":
    case "session_busy":
    case "session_not_found":
      return AGENT_EXIT_CODES.conflict
    case "timeout":
    case "idle_timeout":
      return AGENT_EXIT_CODES.timeout
    case "cancelled":
      return AGENT_EXIT_CODES.sigint
    case "interrupted":
      return AGENT_EXIT_CODES.sigterm
    default:
      return AGENT_EXIT_CODES.runtimeFailure
  }
}

// ---- Result -----------------------------------------------------------------

export type AgentRunStatus = "completed" | "failed" | "cancelled" | "timeout"

export interface AgentRunUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** Provider-reported cost when one was returned. */
  costUsd?: number
}

/** Where (and whether) this run's canonical history landed. */
export interface AgentSessionPersistence {
  /** False for `--no-session`: nothing was written, and resume is impossible. */
  persisted: boolean
  /** Root the canonical store wrote under (absent when `persisted` is false). */
  sessionDir?: string
  /** Turns appended by THIS run (not the session total). */
  turnsAppended?: number
  /** Total canonical turns in the session after this run. */
  turnCount?: number
  /** Set when the session was created by forking/cloning another. */
  lineage?: {
    parentSessionId: string
    parentTurnId?: string
    kind: "fork" | "clone"
  }
}

/** How faithfully a resumed session was restored, and what was lost doing it. */
export interface AgentResumeReport {
  /** True when the runtime accepted its own native binding (no replay). */
  native: boolean
  fidelity: SessionFidelity
  loss: SessionLossReport
  /** Legacy flat-JSONL lines that could not be parsed, reported not swallowed. */
  invalidLegacyLines?: number
}

export interface AgentRunResultV1 {
  schemaVersion: 1
  type: "result"
  status: AgentRunStatus

  // ---- Identity ----
  sessionId: string
  runId: string
  turnId: string
  attemptId: string
  /** The runtime's own session handle, when it exposes one (binding only). */
  nativeSessionId?: string

  /** Final assistant text. Empty string when the run produced none. */
  text: string
  usage?: AgentRunUsage

  // ---- What actually ran ----
  /** Backend id actually selected — never a silent substitute for `--backend`. */
  backend: string
  model: string
  provider?: string
  /** Capability ids effective for this run, after clamping. */
  capabilities: AgentCapabilityId[]

  session: AgentSessionPersistence
  /** Present only when this run resumed or imported prior history. */
  resume?: AgentResumeReport

  /** Present iff `status !== "completed"`. */
  error?: AgentStructuredError

  /** Deprecation / trust / degradation notices already emitted as events. */
  warnings?: Array<{ code: string; message: string }>
}

// ---- Validation -------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const RUN_STATUSES: readonly string[] = ["completed", "failed", "cancelled", "timeout"]

/** Validate an `AgentRunResultV1`. Returns violations (empty = valid). */
export function validateAgentRunResult(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["run result must be an object"]

  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (value.type !== "result") errors.push('type must be "result"')
  if (!RUN_STATUSES.includes(value.status as string)) {
    errors.push(`status must be one of ${RUN_STATUSES.join("|")}`)
  }
  for (const key of ["sessionId", "runId", "turnId", "attemptId", "backend", "model"] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`)
  }
  if (typeof value.text !== "string") errors.push("text must be a string")
  if (!Array.isArray(value.capabilities)) errors.push("capabilities must be an array")

  const session = value.session
  if (!isRecord(session) || typeof session.persisted !== "boolean") {
    errors.push("session.persisted must be a boolean")
  } else if (session.persisted && !isNonEmptyString(session.sessionDir)) {
    errors.push("session.sessionDir is required when persisted")
  }

  if (value.resume !== undefined) {
    const resume = value.resume
    if (!isRecord(resume) || typeof resume.native !== "boolean") {
      errors.push("resume.native must be a boolean")
    } else if (!SESSION_FIDELITY_LEVELS.includes(resume.fidelity as SessionFidelity)) {
      errors.push("resume.fidelity must be a known fidelity level")
    } else if (!isRecord(resume.loss)) {
      errors.push("resume.loss must be a loss report")
    }
  }

  const failed = value.status !== "completed"
  const error = value.error
  if (failed && !isRecord(error)) {
    errors.push("error is required when status is not completed")
  } else if (!failed && error !== undefined) {
    errors.push("error must be absent when status is completed")
  } else if (isRecord(error)) {
    if (!(AGENT_ERROR_CODES as readonly string[]).includes(error.code as string)) {
      errors.push("error.code must be a known agent error code")
    }
    if (!isNonEmptyString(error.message)) errors.push("error.message must be a non-empty string")
  }

  return errors
}

export function isAgentRunResult(value: unknown): value is AgentRunResultV1 {
  return validateAgentRunResult(value).length === 0
}
