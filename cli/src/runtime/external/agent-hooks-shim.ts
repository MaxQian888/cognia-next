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

export async function fireAgentHook(
  _event: string,
  _ctx: AgentHookContext,
  _opts?: { toolName?: string; payload?: Record<string, unknown> }
): Promise<AgentHookDecision | null> {
  return null
}

export async function observeExternalAgentEvent(
  _ctx: AgentHookContext,
  _event: ExternalAgentEvent,
  _emit?: EmitHookNotice
): Promise<void> {}

export async function gateExternalAgentPermission(
  _ctx: AgentHookContext,
  _event: ExternalAgentPermissionRequestEvent,
  _deny: (requestId: string, reason: string) => Promise<void>,
  _emit?: EmitHookNotice
): Promise<boolean> {
  return false
}
