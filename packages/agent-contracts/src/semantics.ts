/**
 * Execution semantics of one runtime (ADR-0217).
 *
 * Boolean capability flags could not say what a cancel actually stops or
 * whether a resume is native. DeepSeek Harness, for example, has no wire
 * cancel: stopping a turn retires the per-session process, so the session must
 * be reopened. A scheduler that treated that as a turn interrupt would reuse a
 * dead session. These fields carry the difference so orchestration, the UI
 * and resource accounting can respect it.
 */

/** What a cancel reaches. */
export type AgentCancelScope = "turn" | "session" | "process"

export interface AgentCancelSemantics {
  scope: AgentCancelScope
  /**
   * True when the session cannot take another turn after a cancel until the
   * host reconnects (re-opens the session or relaunches the process).
   */
  reconnectsAfterCancel: boolean
}

/**
 * How a session continues after its process is gone.
 *
 * - `native`: the runtime reattaches to its own stored session by id.
 * - `relaunch-with-session`: a new process is started pointed at the stored
 *   session (Pi `--session-id`).
 * - `history-replay`: the host replays its own transcript into a new session
 *   (Aider chat files). This is not native resume and must not be shown as one.
 * - `unsupported`: a new session starts empty.
 */
export type AgentResumeSemantics =
  "native" | "relaunch-with-session" | "history-replay" | "unsupported"

/**
 * How a fork is produced.
 *
 * - `native`: any point, by the runtime.
 * - `native-turn-boundary`: by the runtime, only at a completed turn.
 * - `before-entry`: by the runtime, only before a published entry.
 * - `unsupported`.
 */
export type AgentForkSemantics = "native" | "native-turn-boundary" | "before-entry" | "unsupported"

/**
 * Where tool approvals are decided.
 *
 * - `per-tool-call`: the runtime asks the host for each call.
 * - `profile-fixed`: authority is fixed at launch; per-call answers are refused.
 * - `none`: the runtime has no approval channel (it runs inside the host sandbox).
 */
export type AgentApprovalSemantics = "per-tool-call" | "profile-fixed" | "none"

/**
 * How processes map to sessions.
 *
 * - `shared`: one process serves many sessions.
 * - `per-session`: each session owns a process.
 * - `per-turn`: a process lives for one turn.
 * - `remote`: the runtime is reached over the network; the host owns no process.
 */
export type AgentProcessModel = "shared" | "per-session" | "per-turn" | "remote"

export interface AgentExecutionSemantics {
  cancel: AgentCancelSemantics
  resume: AgentResumeSemantics
  fork: AgentForkSemantics
  approvals: AgentApprovalSemantics
  processModel: AgentProcessModel
  /** Upper bound on concurrent processes the runtime itself enforces, if any. */
  maxProcesses?: number
}

/**
 * The conservative reading for an adapter that declares nothing (plugin
 * adapters written before ADR-0217): a cancel may take the whole process down
 * and require a reconnect, nothing resumes or forks, and approvals are asked.
 * Never more permissive than an adapter could actually be.
 */
export const UNDECLARED_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "process", reconnectsAfterCancel: true }),
  resume: "unsupported",
  fork: "unsupported",
  approvals: "per-tool-call",
  processModel: "shared",
}) as AgentExecutionSemantics

/** The semantics an adapter declares, or the conservative default. */
export function executionSemanticsOf(adapter: {
  readonly semantics?: AgentExecutionSemantics
}): AgentExecutionSemantics {
  return adapter.semantics ?? UNDECLARED_EXECUTION_SEMANTICS
}

/**
 * True when cancelling one session's turn leaves the runtime's other sessions
 * untouched. A process-scoped cancel on a shared process would stop them all.
 */
export function cancelIsolatedToSession(semantics: AgentExecutionSemantics): boolean {
  if (semantics.cancel.scope !== "process") return true
  return semantics.processModel !== "shared"
}

/** True when a cancelled session must be reconnected before its next turn. */
export function requiresReconnectAfterCancel(semantics: AgentExecutionSemantics): boolean {
  return semantics.cancel.reconnectsAfterCancel || semantics.cancel.scope !== "turn"
}
