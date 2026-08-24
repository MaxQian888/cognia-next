/**
 * Unified Execution Broker — shared types.
 *
 * The broker is a single global admission governor + observability registry
 * that sits in front of every AI turn the app drives, no matter which
 * subsystem triggered it (foreground chat, workflow agent step, scheduler,
 * connector auto-reply, sub-agent, goal, team). Before the broker, each of
 * those four subsystems enforced its own concurrency cap and none knew about
 * the others, so they could all hammer the same sidecar at once. The broker
 * unifies admission ("ai-turn" weighted semaphore), registration (one record
 * per in-flight leg), and cancellation (by id / session / project / global).
 *
 * See ADR notes in `docs/content/docs/en/adr/0045-unified-plan-execution-hub.md`
 * for the surrounding execution-hub design; this module is the concurrency
 * spine that hub plugs into.
 */

/**
 * Which subsystem owns an in-flight execution leg. Drives both the
 * observability panel grouping and the cross-trigger completion event the
 * broker emits when a leg settles.
 */
export type ExecutionLegKind =
  "chat" | "workflow-step" | "scheduled" | "connector" | "subagent" | "goal" | "team"

/**
 * The shared resource an admission competes for. Today every AI turn shares
 * the one sidecar, so there is a single class; the type is kept open so a
 * future split (e.g. a dedicated embedding pool) can add a class without
 * reworking the broker.
 */
export type ExecutionResourceClass = "ai-turn"

/** Lifecycle phase of a registered leg. */
export type ExecutionLegState = "queued" | "running"

/** How a settled leg finished — surfaced on the `leg-completed` event. */
export type ExecutionLegOutcome = "ok" | "error" | "cancelled"

/**
 * A request to admit one execution leg. Passed to {@link ExecutionBroker.acquire}.
 */
export interface ExecutionLeaseRequest {
  /** Subsystem that owns this leg. */
  kind: ExecutionLegKind
  /** Resource pool to admit against. Defaults to `"ai-turn"`. */
  resource?: ExecutionResourceClass
  /** Human-readable label for the observability panel (already-translated or an i18n key the panel resolves). */
  label: string
  /** Chat / SDK session id, when the leg runs against a real session. */
  sessionId?: string
  /** Workflow run id, when the leg is a workflow step. */
  runId?: string
  /** Scheduler / background task id, when the leg was launched by the scheduler. */
  taskId?: string
  /** Workspace (Project) id this leg belongs to — drives per-project cancel. */
  projectId?: string
  /**
   * The EXECUTION SLOT this leg mutates — a working tree, a sandbox, a remote
   * runtime. At most one leg holds a given slot at a time.
   *
   * The pool cap answers "how much work at once"; it does not answer "may
   * these two run in the SAME directory". Two conversations bound to one
   * checkout, or two scheduled tasks in one worktree, both fitted comfortably
   * under a 16-permit cap and then interleaved edits, builds and git
   * operations in the same tree. Serializing per slot is what makes "parallel
   * across slots" safe to offer at all.
   *
   * Omitted for a leg that mutates nothing shared (a read-only query, a
   * cloud-only turn). Legs exempted from the cap — a continuation of a session
   * that is already running — do not take the slot either: they ARE the work
   * already holding it.
   */
  slotKey?: string
  /**
   * Admission weight (defaults to 1). A heavier leg occupies more of the
   * pool's limit; used so a fan-out parent can reserve headroom.
   */
  weight?: number
  /**
   * Caller cancellation signal. When it aborts, the broker cancels the lease
   * (its {@link ExecutionLease.signal} fires) and, if still queued, the
   * acquire promise rejects with an abort error.
   */
  signal?: AbortSignal
  /**
   * Force exemption from the cap regardless of continuation detection. Exempt
   * legs are admitted immediately and do NOT consume a permit — the broker
   * still registers them for observability. Foreground chat continuations of
   * an already-running session are auto-exempted (see broker docs); pass this
   * only for callers that must never block.
   */
  exempt?: boolean
}

/**
 * Immutable snapshot of a registered leg. The observability panel renders a
 * list of these; the lifecycle event carries one.
 */
export interface ExecutionLegSnapshot {
  id: string
  kind: ExecutionLegKind
  resource: ExecutionResourceClass
  label: string
  sessionId?: string
  runId?: string
  taskId?: string
  projectId?: string
  /**
   * The execution slot this leg wants. Present on the snapshot so a surface
   * can say WHY a leg is queued — waiting for a permit and waiting for a
   * directory look identical otherwise, and "queued" with no reason reads as
   * "hung".
   */
  slotKey?: string
  /** True while this leg is the one holding {@link slotKey}. */
  holdsSlot?: boolean
  weight: number
  exempt: boolean
  state: ExecutionLegState
  startedAt: number
  /** True once {@link ExecutionBroker.cancel} (or a matching bulk cancel) has fired for this leg. */
  cancelled: boolean
}

/**
 * The grant returned by {@link ExecutionBroker.acquire}. The caller passes
 * {@link signal} to whatever drives the turn (e.g. `runAndCaptureAssistantReply`'s
 * `cap.signal`) and MUST call {@link release} exactly once when the turn settles.
 */
export interface ExecutionLease {
  readonly id: string
  readonly request: ExecutionLeaseRequest
  readonly resource: ExecutionResourceClass
  readonly weight: number
  readonly exempt: boolean
  readonly startedAt: number
  /**
   * Aborted when this lease is cancelled (by id, session, project, global, or
   * the caller's own request signal). Combine it with any caller signal and
   * hand it to the turn driver so a broker-side cancel actually stops the run.
   */
  readonly signal: AbortSignal
  /** Whether this lease has been cancelled. */
  readonly cancelled: boolean
  /**
   * Release the permit and unregister the leg. Idempotent. Pass the outcome so
   * the `leg-completed` event reports `ok` / `error`; a cancelled lease always
   * reports `cancelled` regardless of the argument.
   */
  release(outcome?: ExecutionLegOutcome): void
}

/** Lifecycle events emitted to {@link ExecutionBroker.onEvent} subscribers. */
export type ExecutionBrokerEvent =
  | { type: "leg-started"; snapshot: ExecutionLegSnapshot }
  | { type: "leg-completed"; snapshot: ExecutionLegSnapshot; outcome: ExecutionLegOutcome }

/**
 * Admission metadata a turn driver (e.g. `runAndCaptureAssistantReply`) carries
 * so it can register its leg with the broker. Every field is optional: the
 * driver fills sensible defaults (kind `"subagent"`, a label derived from the
 * session). Set {@link skip} to bypass admission entirely for a caller that is
 * already governed elsewhere.
 */
export interface ExecutionLeaseInfo {
  kind?: ExecutionLegKind
  label?: string
  sessionId?: string
  runId?: string
  taskId?: string
  projectId?: string
  weight?: number
  /** When true, skip broker admission (legacy / already-governed path). */
  skip?: boolean
}
