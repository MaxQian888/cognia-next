export type RecoveryMode = "normal" | "safe" | "recovering"

export interface RecoveryAuditEntry {
  at: number
  code: string
  subsystem?: string
  success?: boolean
}

export interface RecoveryState {
  schemaVersion: 1
  buildId: string
  unhealthyBuildId: string
  mode: RecoveryMode
  unhealthyStarts: number[]
  lastRendererReloadAt?: number
  childRestartAttempts: Record<string, number>
  stableSince?: number
  suspectSubsystem?: string
  audit: RecoveryAuditEntry[]
}

export function createRecoveryState(buildId: string): RecoveryState {
  return {
    schemaVersion: 1,
    buildId,
    unhealthyBuildId: buildId,
    mode: "normal",
    unhealthyStarts: [],
    childRestartAttempts: {},
    audit: [],
  }
}

function appendAudit(state: RecoveryState, entry: RecoveryAuditEntry): RecoveryAuditEntry[] {
  return [...state.audit, entry].slice(-100)
}

export function recordUnhealthyStart(state: RecoveryState, at: number): RecoveryState {
  const sameBuild = state.unhealthyBuildId === state.buildId
  const recent = (sameBuild ? state.unhealthyStarts : []).filter(
    (startedAt) => at - startedAt <= 10 * 60_000 && startedAt <= at
  )
  const unhealthyStarts = [...recent, at]
  return {
    ...state,
    unhealthyBuildId: state.buildId,
    unhealthyStarts,
    mode: unhealthyStarts.length >= 2 ? "safe" : state.mode,
    stableSince: undefined,
    audit: appendAudit(state, { at, code: "recovery.start.unhealthy" }),
  }
}

export function recordRendererFailure(
  state: RecoveryState,
  at: number
): { state: RecoveryState; action: "reload" | "open-safe-mode" } {
  const canReload =
    state.lastRendererReloadAt === undefined || at - state.lastRendererReloadAt >= 5 * 60_000
  if (canReload) {
    return {
      action: "reload",
      state: {
        ...state,
        lastRendererReloadAt: at,
        audit: appendAudit(state, { at, code: "recovery.renderer.reload" }),
      },
    }
  }
  return {
    action: "open-safe-mode",
    state: {
      ...state,
      mode: "safe",
      suspectSubsystem: "renderer",
      audit: appendAudit(state, { at, code: "recovery.renderer.reload_blocked" }),
    },
  }
}

export type ChildRecoveryAction =
  | { kind: "restart"; delayMs: number; attempt: number }
  | { kind: "disable"; suspectSubsystem: string }

export function recordChildFailure(
  state: RecoveryState,
  subsystem: string,
  at: number
): { state: RecoveryState; action: ChildRecoveryAction } {
  const attempt = (state.childRestartAttempts[subsystem] ?? 0) + 1
  const attempts = { ...state.childRestartAttempts, [subsystem]: attempt }
  if (attempt <= 3) {
    return {
      action: { kind: "restart", delayMs: 2 ** (attempt - 1) * 1_000, attempt },
      state: {
        ...state,
        childRestartAttempts: attempts,
        audit: appendAudit(state, {
          at,
          code: "recovery.child.restart",
          subsystem,
        }),
      },
    }
  }
  return {
    action: { kind: "disable", suspectSubsystem: subsystem },
    state: {
      ...state,
      mode: "safe",
      childRestartAttempts: attempts,
      suspectSubsystem: subsystem,
      audit: appendAudit(state, {
        at,
        code: "recovery.child.disabled",
        subsystem,
      }),
    },
  }
}

export function recordSubsystemCheckpoint(
  state: RecoveryState,
  subsystem: string,
  success: boolean,
  at: number
): RecoveryState {
  if (!success) {
    return {
      ...state,
      mode: "safe",
      stableSince: undefined,
      suspectSubsystem: subsystem,
      audit: appendAudit(state, {
        at,
        code: "recovery.checkpoint.failed",
        subsystem,
        success,
      }),
    }
  }
  return {
    ...state,
    mode: "recovering",
    stableSince: state.mode === "recovering" ? state.stableSince : at,
    suspectSubsystem: state.suspectSubsystem === subsystem ? undefined : state.suspectSubsystem,
    audit: appendAudit(state, {
      at,
      code: "recovery.checkpoint.passed",
      subsystem,
      success,
    }),
  }
}

export function recordHealthyCheckpoint(state: RecoveryState, at: number): RecoveryState {
  const stableSince = state.stableSince ?? at
  if (state.mode !== "recovering" || at - stableSince < 10 * 60_000) {
    return { ...state, stableSince }
  }
  return {
    ...state,
    mode: "normal",
    unhealthyStarts: [],
    childRestartAttempts: {},
    stableSince: undefined,
    suspectSubsystem: undefined,
    audit: appendAudit(state, { at, code: "recovery.stable" }),
  }
}
