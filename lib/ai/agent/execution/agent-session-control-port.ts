import type {
  AgentPermissionMode,
  SendContent,
  SessionControlMethod,
} from "@cognia/agent-config-types"
import type {
  AgentEventEnvelope,
  ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"

/**
 * Transport-neutral control surface for an already-resolved agent session.
 *
 * The renderer's `AgentExecutionHandle` implements this over Tauri IPC. The
 * headless host implements the same semantics over its live provider session.
 * Neither adapter may re-resolve the frozen execution spec.
 */
export interface AgentSessionControlPort {
  readonly sessionId: string
  readonly spec: ResolvedAgentExecutionSpec
  events(onEnvelope: (envelope: AgentEventEnvelope) => void): Promise<() => void>
  interrupt(): Promise<void>
  cancel(): Promise<void>
  compact(focus?: string): Promise<void>
  resolvePermission(
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    options?: {
      message?: string
      updatedInput?: Record<string, unknown>
      interrupt?: boolean
    }
  ): Promise<void>
  setModel(model: string): Promise<void>
  setPermissionMode(mode: AgentPermissionMode): Promise<void>
  steer(prompt: SendContent, priority?: "now" | "next"): Promise<{ accepted: true }>
  control<T = unknown>(
    method: Exclude<SessionControlMethod, "steer">,
    params?: Record<string, unknown>
  ): Promise<T>
}
