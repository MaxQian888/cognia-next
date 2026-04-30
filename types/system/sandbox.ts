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
