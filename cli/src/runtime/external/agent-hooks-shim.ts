import type {
  ExternalAgentEvent,
  ExternalAgentPermissionRequestEvent,
} from "@/types/agent/external-agent"

export interface AgentHookDecision {
  block?: string | null
  additionalContext?: string | null
  warnings: string[]
}
export interface AgentHookContext {
  agentId: string
  sessionId: string
  cwd?: string
}
export interface ExternalHookFireNotice {
  event: string
  toolName?: string
  outcome: "blocked" | "context" | "warning"
  block?: string
  additionalContext?: string
  warnings: string[]
}
export type EmitHookNotice = (notice: ExternalHookFireNotice) => void

/** Convert a hook decision into the notice shape consumed by the shared manager. */
export function noticeFromDecision(
  event: string,
  toolName: string | undefined,
  decision: AgentHookDecision | null
): ExternalHookFireNotice | null {
  if (!decision) return null
  const block = decision.block?.trim() || undefined
  const additionalContext = decision.additionalContext?.trim() || undefined
  const warnings = decision.warnings ?? []
  const outcome = block
    ? "blocked"
    : additionalContext
      ? "context"
      : warnings.length > 0
        ? "warning"
        : null
  return outcome ? { event, toolName, outcome, block, additionalContext, warnings } : null
}

/**
 * Apply the CLI v1 hook policy.
 *
 * The desktop hook runtime depends on Tauri and persisted desktop hook state,
 * neither of which belongs in the standalone CLI host. Returning no decision
 * is the deliberate CLI policy until a CLI-native hook loader is introduced.
 */
export async function fireAgentHook(
  _event: string,
  _ctx: AgentHookContext,
  _opts?: { toolName?: string; payload?: Record<string, unknown> }
): Promise<AgentHookDecision | null> {
  return null
}

/** Observe an external event under the CLI v1 no-hooks policy. */
export async function observeExternalAgentEvent(
  _ctx: AgentHookContext,
  _event: ExternalAgentEvent,
  _emit?: EmitHookNotice
): Promise<void> {}

/** Allow the normal CLI permission gate to handle requests when hooks are disabled. */
export async function gateExternalAgentPermission(
  _ctx: AgentHookContext,
  _event: ExternalAgentPermissionRequestEvent,
  _deny: (requestId: string, reason: string) => Promise<void>,
  _emit?: EmitHookNotice
): Promise<boolean> {
  return false
}
