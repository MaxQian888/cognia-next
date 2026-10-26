/**
 * The plugin contract's share of `lib/ai/agent/external/agent-readiness.ts`, which re-exports these.
 */
/** Compact per-agent state used for rail rows, pills, and the board. */
export type AgentReadinessState =
  "disabled" | "blocked" | "error" | "connecting" | "connected" | "off"

export type AgentReadinessStepId = "configured" | "runnable" | "connected" | "routed"

export type AgentReadinessStepState = "done" | "current" | "failed" | "todo" | "off"

export interface AgentReadinessStep {
  id: AgentReadinessStepId
  state: AgentReadinessStepState
  optional?: boolean
}

/**
 * What the one action button on a row/header should do. Kept as ids — lib/
 * stays locale-free, the renderer maps these to labels and handlers.
 */
export type AgentReadinessAction = "enable" | "inspect" | "retry" | "connect" | "add-rule"
