/**
 * `RecoveryStateV1` — the renderer's *read* model for diagnostics-first safe
 * mode (ADR-0102 §4).
 *
 * This module deliberately has no transitions. It replaces `recovery-policy.ts`,
 * which implemented the whole state machine in TypeScript and was called by
 * nothing: the capability matrix advertised a recovery path that could never
 * fire, because the code that would have fired it lived in the process that
 * dies first. Transitions now belong to `cognia_observability::recovery`, run
 * in the native runtime, and reach the renderer over typed IPC.
 *
 * What is left here is what the renderer legitimately owns: the wire types and
 * pure selectors over a state it received. The shapes mirror the Rust structs
 * field-for-field and are pinned by the shared golden scenarios in
 * `schemas/recovery-fixtures/`.
 */

export type RecoveryMode = "normal" | "safe" | "recovering"

/**
 * The six subsystem groups, in the order they are re-enabled. Closed set — a
 * seventh group changes the recovery contract and needs an ADR amendment.
 */
export const RECOVERY_ORDER = [
  "database",
  "plugins",
  "sidecar",
  "connectors",
  "workflow",
  "external-agent",
] as const

export type RecoverySubsystem = (typeof RECOVERY_ORDER)[number]

export type CheckpointStatus = "pending" | "passed" | "failed" | "skipped"

export interface CheckpointResult {
  subsystem: RecoverySubsystem
  status: CheckpointStatus
  reasonCode?: string
  /** Epoch milliseconds. Absent while pending. */
  at?: number
}

export interface RecoveryAuditEntry {
  /** Epoch milliseconds. */
  at: number
  code: string
  subsystem?: RecoverySubsystem
  success?: boolean
  reasonCode?: string
}

export interface RendererReloadBudget {
  lastReloadAt?: number
  automaticReloadsDisabled?: boolean
}

export interface RecoveryStateV1 {
  schemaVersion: 1
  buildId: string
  mode: RecoveryMode
  unhealthyStarts: number[]
  checkpoints: CheckpointResult[]
  suspectSubsystem?: RecoverySubsystem
  suspectReasonCode?: string
  stableSince?: number
  rendererReload: RendererReloadBudget
  childRestarts: Partial<Record<RecoverySubsystem, number>>
  disabledSubsystems: RecoverySubsystem[]
  rendererAlive: boolean
  audit: RecoveryAuditEntry[]
}

/** This session's boot decision, read once before mounting initializers. */
export interface RecoveryBoot {
  requiresSafeShell: boolean
  mode: RecoveryMode
  buildId: string
  previousSessionUnhealthy: boolean
}

export function isRecoverySubsystem(value: unknown): value is RecoverySubsystem {
  return typeof value === "string" && (RECOVERY_ORDER as readonly string[]).includes(value)
}

/** True when the app must mount the diagnostics shell instead of the full UI. */
export function requiresSafeShell(state: Pick<RecoveryStateV1, "mode">): boolean {
  return state.mode === "safe"
}

export function checkpointFor(
  state: Pick<RecoveryStateV1, "checkpoints">,
  subsystem: RecoverySubsystem
): CheckpointResult | undefined {
  return state.checkpoints.find((checkpoint) => checkpoint.subsystem === subsystem)
}

/**
 * Whether every *enabled* subsystem has passed. A subsystem the operator chose
 * to keep disabled does not block health — they already accepted running
 * without it.
 */
export function allEnabledCheckpointsPassed(
  state: Pick<RecoveryStateV1, "checkpoints" | "disabledSubsystems">
): boolean {
  return state.checkpoints.every(
    (checkpoint) =>
      state.disabledSubsystems.includes(checkpoint.subsystem) || checkpoint.status === "passed"
  )
}

/**
 * The next subsystem whose probe should run, or `undefined` when the sequence
 * finished or is blocked by a failure.
 */
export function nextCheckpoint(
  state: Pick<RecoveryStateV1, "checkpoints" | "disabledSubsystems">
): RecoverySubsystem | undefined {
  for (const checkpoint of state.checkpoints) {
    if (state.disabledSubsystems.includes(checkpoint.subsystem)) continue
    if (checkpoint.status === "pending") return checkpoint.subsystem
    if (checkpoint.status === "failed" || checkpoint.status === "skipped") return undefined
  }
  return undefined
}

/** Ordered progress for the `/logs` recovery pane. */
export interface RecoveryProgress {
  total: number
  passed: number
  failed: number
  skipped: number
  pending: number
  disabled: number
}

export function recoveryProgress(
  state: Pick<RecoveryStateV1, "checkpoints" | "disabledSubsystems">
): RecoveryProgress {
  const progress: RecoveryProgress = {
    total: state.checkpoints.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    disabled: state.disabledSubsystems.length,
  }
  for (const checkpoint of state.checkpoints) {
    progress[checkpoint.status] += 1
  }
  return progress
}

/**
 * The suspected cause, if the runtime named one. Returned as data rather than a
 * formatted string so the caller localizes it — the reason code is a stable
 * identifier, not display text.
 */
export interface RecoverySuspect {
  subsystem?: RecoverySubsystem
  reasonCode?: string
}

export function recoverySuspect(
  state: Pick<RecoveryStateV1, "suspectSubsystem" | "suspectReasonCode">
): RecoverySuspect | undefined {
  if (!state.suspectSubsystem && !state.suspectReasonCode) return undefined
  return { subsystem: state.suspectSubsystem, reasonCode: state.suspectReasonCode }
}

/** Whether automatic renderer reloads are currently spent. */
export function automaticReloadsDisabled(state: Pick<RecoveryStateV1, "rendererReload">): boolean {
  return state.rendererReload.automaticReloadsDisabled === true
}

/** Newest-first audit history, for the recovery pane's timeline. */
export function recentRecoveryAudit(
  state: Pick<RecoveryStateV1, "audit">,
  limit = 20
): RecoveryAuditEntry[] {
  return [...state.audit].reverse().slice(0, Math.max(0, limit))
}
