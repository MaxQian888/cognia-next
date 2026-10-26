// Minimal sandbox type subset required by the scheduler. The full sandbox
// subsystem from Cognia is not ported into cognia-next; we keep just the
// types that the system-scheduler surface references so its task results can
// carry consumption metadata without dragging in the whole runtime.

export type SandboxEntrypointId =
  | "chat-code-block"
  | "ai-code-block"
  | "workflow-code-step"
  | "scheduler-script"
  | "computer-operation"
  | "designer-preview"

export type SandboxConsumptionMode = "interactive" | "background"

export type SandboxDegradedBehavior = "disable" | "blocked-result" | "bypass"

export interface SandboxConsumptionMetadata {
  entrypoint: SandboxEntrypointId
  mode: SandboxConsumptionMode
  degraded_behavior: SandboxDegradedBehavior
  requires_preflight: boolean
  sandbox_enabled: boolean
  blocked: boolean
  bypassed: boolean
  used_quick_run: boolean
  policy_profile?: string | null
}

/**
 * Result returned by sandboxed plugin script executions. The plugin
 * sandbox runtime returns this to the host so it can decide whether to
 * surface stdout, propagate the error, or record the quota draw.
 */
export interface SandboxExecutionResult {
  ok: boolean
  /** Optional structured value returned by the script. */
  value?: unknown
  /** Free-form stdout / log lines collected during execution. */
  logs?: string[]
  /** Error message if `ok === false`. Never throws across the boundary. */
  error?: string
  /** Wall-clock duration in ms, measured around the script invocation. */
  durationMs?: number
  /** Consumption metadata if the host policy required preflight bookkeeping. */
  consumption?: SandboxConsumptionMetadata
}
